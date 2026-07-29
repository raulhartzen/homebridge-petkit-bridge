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
 * Video path: bridge (WHEP) -> go2rtc (RTSP) -> ffmpeg -> HomeKit (SRTP).
 * The RTSP stream is auto-registered on go2rtc by the platform; snapshots
 * come from go2rtc's frame endpoint (no ffmpeg involved).
 * v1 scope: video only (no audio, no HKSV).
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
      const ssrc = hap.CameraController.generateSynchronisationSource();
      const video = request.video;
      this.sessions.set(request.sessionID, {
        address: request.targetAddress,
        videoPort: video.port,
        ssrc,
        videoSRTP: Buffer.concat([video.srtp_key, video.srtp_salt]).toString('base64'),
      });
      callback(undefined, {
        video: {
          port: returnPort,
          ssrc,
          srtp_key: video.srtp_key,
          srtp_salt: video.srtp_salt,
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
        const args = [
          '-hide_banner', '-loglevel', 'error',
          '-rtsp_transport', 'tcp',
          '-i', this.rtspUrl,
          '-an', '-sn', '-dn',
          ...encode,
          '-payload_type', String(v.pt),
          '-ssrc', String(session.ssrc),
          '-f', 'rtp',
          '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
          '-srtp_out_params', session.videoSRTP,
          `srtp://${session.address}:${session.videoPort}` +
            `?rtcpport=${session.videoPort}&pkt_size=1316`,
        ];
        this.platform.log.info(
          '[%s] starting stream (%dx%d, %s)',
          this.accessory.displayName, v.width, v.height, vcodec,
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
