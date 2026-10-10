// 診断は専用保存先のmetadata.jsonだけに残す。外部例外・音声・鍵は記録しない。
export interface DiagnosticEvent { type: string; userId?: string; value?: string }
export interface ReceiveMetrics {
  subscriptionsStarted: number; subscriptionsClosed: number; streamErrors: number;
  rtpPackets: number; opusPackets: number; speakingStarts: number;
  lastRtpAt: string | null; lastOpusAt: string | null;
  desired: boolean; subscribed: boolean; ssrcKnown: boolean;
}
export interface ReceiverDiagnostics {
  users: Record<string, ReceiveMetrics>;
  unknownSsrcPackets: number;
  dave: { failureSignals: number; errorSignals: number; protocolVersion: number | null; ready: boolean; reinitializing: boolean };
}
export interface RecordingDiagnostics {
  receiver?: ReceiverDiagnostics;
  events: (DiagnosticEvent & { at: string; offsetMs: number | null })[];
  droppedEvents: number;
  lastError?: DiagnosticEvent & { at: string; offsetMs: number | null };
}
export function errorCategory(error: unknown): string {
  // message/stack/codeにはトークン・ユーザーID等が入り得る。固定の分類だけを保存する。
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof RangeError) return 'range_error';
  if (error instanceof Error) return 'error';
  return 'unknown_error';
}
