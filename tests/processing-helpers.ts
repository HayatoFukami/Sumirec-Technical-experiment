import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, GUILD, A } from './helpers.js';
import { privateDirectory, WavWriter, atomicJson } from '../src/storage.js';
import type { Metadata, VadClass } from '../src/model.js';
import { sttConfig, minutesConfig } from '../src/processing-config.js';

export async function recordingFixture(items: { userId?: string; start?: number; ms?: number; classification?: VadClass; complete?: boolean; value?: number }[] = [{}], guild = GUILD) {
  const { root } = await config(); const session = randomUUID();
  const directory = await privateDirectory(root, [guild, session]);
  const metadata: Metadata = {
    schemaVersion: 2, guildId: guild, sessionId: session, channelId: '223456789012345678', ownerId: A,
    preparedAt: '2026-10-12T00:00:00Z', recordingStartedAt: '2026-10-12T00:00:00Z', endedAt: '2026-10-12T00:01:40Z', durationMs: 100_000, state: 'completed',
    format: { container: 'WAV', encoding: 'PCM_S16LE', sampleRate: 48_000, channels: 2 },
    participants: {}, users: {}, segments: [], events: [], reconnects: 0, peakParticipants: 2, savedFiles: 0, savedBytes: 0,
    memoryAtEnd: null, errorCode: null, exportFile: null, exportError: null, limitations: [],
  };
  for (const [index,item] of items.entries()) {
    const userId = item.userId ?? A, classification = item.classification ?? 'speech';
    const ms = item.ms ?? 1000, start = item.start ?? index * 2000;
    const userDirectory = await privateDirectory(directory, ['users',userId,classification]);
    const name = `segment-${String(index + 1).padStart(4,'0')}.wav`;
    const writer = await WavWriter.create(join(userDirectory, name));
    const pcm = Buffer.alloc(ms * 48 * 4); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(item.value ?? index + 1,i);
    await writer.append(pcm); const bytes = await writer.finish();
    metadata.segments.push({ userId, file: `users/${userId}/${classification}/${name}`, startOffsetMs: start, endOffsetMs: start + ms,
      startAt: '2026-10-12T00:00:00Z', endAt: '2026-10-12T00:00:01Z', firstPacketOffsetMs: start, lastPacketOffsetMs: start + ms,
      durationMs: ms, samples: ms * 48, bytes: bytes + 44, packets: 1, complete: item.complete ?? true, timing: 'arrival-estimate',
      vad: { classification, completed: classification !== 'unclassified', ranges: classification === 'speech' ? [{ startMs: 0, endMs: ms }] : [] } });
  }
  metadata.savedFiles = metadata.segments.length; metadata.savedBytes = metadata.segments.reduce((n,s) => n + s.bytes,0);
  await atomicJson(directory, metadata);
  const stt = { ...sttConfig({}), root, enabled: true, key: 'test-stt-key', endpoint: 'https://test.cognitiveservices.azure.com' };
  const minutes = { ...minutesConfig({}), root, enabled: true, key: 'test-openai-key' };
  return { root, directory, guild, session, metadata, stt, minutes };
}
export function azureResponse(durationMilliseconds = 1000, text = 'テスト発言', start = 0, duration = durationMilliseconds) {
  return new Response(JSON.stringify({ durationMilliseconds, combinedPhrases: [{text}], phrases: text ? [{offsetMilliseconds: start, durationMilliseconds: duration, text}] : [] }));
}
