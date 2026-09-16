import { spawn, ChildProcess } from 'child_process';
import { createSocket } from 'dgram';
import {
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

interface ActiveSession {
  address: string;
  videoPort: number;
  ssrc: number;
  videoSRTP: string; // base64 key+salt
  audioPort: number;
  audioSSRC: number;
  audioSRTP: string; // base64 key+salt
  process?: ChildProcess;
}

/** Reserves a free UDP port by binding to 0 and releasing it. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.on('error', reject);
    socket.bind(0, () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(() => resolve(port));
    });
  });
}

/**
 * Native HomeKit camera for a camera-equipped PetKit device.
 * Media path: bridge (WHEP) -> go2rtc (RTSP) -> ffmpeg -> HomeKit (SRTP).
 * The RTSP stream is auto-registered on go2rtc by the platform; snapshots
 * come from go2rtc's frame endpoint (no ffmpeg involved).
 * Video is passed through (or transcoded, see cameraVcodec); the device's
 * G.711 audio is transcoded to AAC-ELD or Opus for HomeKit. No HKSV.
 */
export class CameraAccessory implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly rtspUrl: string;
  private readonly snapshotUrl: string;

  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
    streamName: string,
  ) {
    const { Service, Characteristic } = platform;
    const hap = platform.api.hap;
    const device = accessory.context.device;

    this.rtspUrl = `${platform.go2rtcRtspBase}/${streamName}`;
    this.snapshotUrl =
      `${platform.go2rtcUrl}/api/frame.jpeg?src=${encodeURIComponent(streamName)}`;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'PetKit (via petkit-bridge)')
      .setCharacteristic(Characteristic.Model, 'camera')
      .setCharacteristic(Characteristic.SerialNumber, String(device.id));

    const controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [1024, 576, 30],
            [640, 360, 30],
            [480, 270, 30],
            [320, 240, 15],
          ],
          codec: {
            profiles: [
              hap.H264Profile.BASELINE,
              hap.H264Profile.MAIN,
              hap.H264Profile.HIGH,
            ],
            levels: [
              hap.H264Level.LEVEL3_1,
              hap.H264Level.LEVEL3_2,
              hap.H264Level.LEVEL4_0,
            ],
          },
        },
        ...(platform.cameraAudio === 'off'
          ? {}
          : {
              audio: {
                twoWayAudio: false,
                codecs: [
                  {
                    type: platform.cameraAudio === 'opus'
                      ? hap.AudioStreamingCodecType.OPUS
                      : hap.AudioStreamingCodecType.AAC_ELD,
                    samplerate: hap.AudioStreamingSamplerate.KHZ_16,
                  },
                ],
              },
            }),
      },
    });
    accessory.configureController(controller);
  }

  async handleSnapshotRequest(
    _request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): Promise<void> {
    try {
      const res = await fetch(this.snapshotUrl, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`frame endpoint -> HTTP ${res.status}`);
      }
      callback(undefined, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      this.platform.log.debug(
        '[%s] snapshot failed: %s',
        this.accessory.displayName,
        String(err),
      );
      callback(err as Error);
    }
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    const hap = this.platform.api.hap;
    try {
      const returnPort = await reservePort();
      const audioReturnPort = await reservePort();
      const ssrc = hap.CameraController.generateSynchronisationSource();
      const audioSSRC = hap.CameraController.generateSynchronisationSource();
      const video = request.video;
      const audio = request.audio;
      this.sessions.set(request.sessionID, {
        address: request.targetAddress,
        videoPort: video.port,
        ssrc,
        videoSRTP: Buffer.concat([video.srtp_key, video.srtp_salt]).toString('base64'),
        audioPort: audio.port,
        audioSSRC,
        audioSRTP: Buffer.concat([audio.srtp_key, audio.srtp_salt]).toString('base64'),
      });
      callback(undefined, {
        video: {
          port: returnPort,
          ssrc,
          srtp_key: video.srtp_key,
          srtp_salt: video.srtp_salt,
        },
        audio: {
          port: audioReturnPort,
          ssrc: audioSSRC,
          srtp_key: audio.srtp_key,
          srtp_salt: audio.srtp_salt,
        },
      });
    } catch (err) {
      callback(err as Error);
    }
  }

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    const session = this.sessions.get(request.sessionID);
    switch (request.type) {
      case 'start': {
        if (!session) {
          callback(new Error('unknown session'));
          return;
        }
        const v = request.video;
        const vcodec = this.platform.cameraVcodec;
        const encode =
          vcodec === 'copy'
            ? ['-codec:v', 'copy']
            : [
                '-codec:v', vcodec,
                '-pix_fmt', 'yuv420p',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-filter:v', `scale=${v.width}:-2`,
                '-b:v', `${v.max_bit_rate}k`,
              ];
        const a = request.audio;
        const audioMode = this.platform.cameraAudio;
        const wantAudio = audioMode !== 'off';
        // HomeKit tells us the codec/sample rate it negotiated; the source is
        // G.711 8 kHz mono, so we upsample to what was requested (16 kHz).
        const audioEncode = !wantAudio
          ? []
          : a.codec === 'OPUS'
            ? ['-codec:a', 'libopus', '-application', 'lowdelay']
            : ['-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-flags', '+global_header'];
        const audioArgs = !wantAudio
          ? []
          : [
              '-map', '0:a:0', '-vn', '-sn', '-dn',
              ...audioEncode,
              '-ac', '1',
              '-ar', `${a.sample_rate}k`,
              '-b:a', `${a.max_bit_rate}k`,
              '-payload_type', String(a.pt),
              '-ssrc', String(session.audioSSRC),
              '-f', 'rtp',
              '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
              '-srtp_out_params', session.audioSRTP,
              `srtp://${session.address}:${session.audioPort}` +
                `?rtcpport=${session.audioPort}&pkt_size=188`,
            ];
        const args = [
          '-hide_banner', '-loglevel', 'error',
          '-rtsp_transport', 'tcp',
          '-i', this.rtspUrl,
          '-map', '0:v:0', '-an', '-sn', '-dn',
          ...encode,
          '-payload_type', String(v.pt),
          '-ssrc', String(session.ssrc),
          '-f', 'rtp',
          '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
          '-srtp_out_params', session.videoSRTP,
          `srtp://${session.address}:${session.videoPort}` +
            `?rtcpport=${session.videoPort}&pkt_size=1316`,
          ...audioArgs,
        ];
        this.platform.log.info(
          '[%s] starting stream (%dx%d, %s, audio: %s)',
          this.accessory.displayName, v.width, v.height, vcodec,
          wantAudio ? `${a.codec} ${a.sample_rate}kHz` : 'off',
        );
        const proc = spawn(this.platform.ffmpegPath, args, { env: process.env });
        proc.stderr?.on('data', (d: Buffer) => {
          this.platform.log.debug('[%s] ffmpeg: %s',
            this.accessory.displayName, d.toString().trim());
        });
        proc.on('error', (err) => {
          this.platform.log.error(
            '[%s] ffmpeg failed to start (%s). Is ffmpeg installed / the ' +
              '"ffmpegPath" config correct?',
            this.accessory.displayName, String(err),
          );
        });
        proc.on('exit', (code, signal) => {
          if (code !== null && code !== 0 && signal !== 'SIGKILL') {
            this.platform.log.warn(
              '[%s] ffmpeg exited unexpectedly (code %s)',
              this.accessory.displayName, String(code),
            );
          }
        });
        session.process = proc;
        callback();
        break;
      }
      case 'stop': {
        session?.process?.kill('SIGKILL');
        this.sessions.delete(request.sessionID);
        this.platform.log.info('[%s] stream stopped', this.accessory.displayName);
        callback();
        break;
      }
      case 'reconfigure':
      default:
        // v1: keep streaming with the original parameters.
        callback();
        break;
    }
  }
}
