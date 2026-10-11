import { join } from 'node:path';
import { emptyMetrics, type Metadata, type Segment } from '../src/model.js';
import { RecordingSession } from '../src/session.js';
import { privateDirectory, WavWriter } from '../src/storage.js';
import { A, config, fixture } from './helpers.js';
export async function storedSession() {
  const cfg = await config();
  const metadata = new RecordingSession(cfg, fixture().options).metadata;
  metadata.state = 'stopping'; metadata.endedAt = '2026-10-11T00:00:01Z'; metadata.durationMs = 1500;
  const directory = await privateDirectory(cfg.root, [metadata.guildId, metadata.sessionId]);
  return { cfg, metadata, directory };
}
export async function addWav(directory: string, metadata: Metadata, pcm = Buffer.alloc(960 * 4), userId = A, start = 80): Promise<Segment> {
  const index = metadata.segments.filter((s) => s.userId === userId).length + 1;
  const name = `segment-${String(index).padStart(4, '0')}.wav`;
  const parent = await privateDirectory(directory, ['users', userId]);
  const writer = await WavWriter.create(join(parent, name));
  await writer.append(pcm); await writer.finish();
  const samples = pcm.length / 4; const durationMs = samples / 48;
  const segment: Segment = { userId, file: `users/${userId}/${name}`, samples, bytes: pcm.length + 44, durationMs,
    startOffsetMs: start, endOffsetMs: start + durationMs, startAt: 'start', endAt: 'end',
    firstPacketOffsetMs: start, lastPacketOffsetMs: start + durationMs, packets: 1, complete: true, timing: 'arrival-estimate' };
  metadata.segments.push(segment); metadata.savedFiles++; metadata.savedBytes += segment.bytes;
  const metrics = metadata.users[userId] ??= emptyMetrics();
  metrics.packets++; metrics.decodeSuccesses!++; metrics.segments++; metrics.savedSamples! += samples;
  metrics.audioDurationMs += durationMs; metrics.bytes += segment.bytes;
  return segment;
}
