import { apiClient } from './api-client';
import type { ImportListeningRequest } from '@/types/listening';

export type ListeningYouTubeJob = {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SAVING' | 'READY' | 'FAILED' | 'CANCELLED';
  stage: string;
  materialId: number | null;
  message: string | null;
  updatedAt: string;
};
const path = '/listening/youtube-jobs';
export const activeYouTubeJob = (job: ListeningYouTubeJob) => ['QUEUED', 'RUNNING', 'SAVING'].includes(job.status);
export const createYouTubeJob = async (request: ImportListeningRequest): Promise<ListeningYouTubeJob> =>
  (await apiClient.post(path, request, { timeout: 15000 })).data;
export const recentYouTubeJobs = async (): Promise<ListeningYouTubeJob[]> =>
  (await apiClient.get(path, { timeout: 10000 })).data;
export const getYouTubeJob = async (id: string): Promise<ListeningYouTubeJob> =>
  (await apiClient.get(`${path}/${encodeURIComponent(id)}`, { timeout: 10000 })).data;
export const cancelYouTubeJob = async (id: string): Promise<ListeningYouTubeJob> =>
  (await apiClient.delete(`${path}/${encodeURIComponent(id)}`, { timeout: 10000 })).data;

export function youTubeStageLabel(job: ListeningYouTubeJob, vi: boolean): string {
  if (job.status === 'FAILED') return job.message || (vi ? 'Chưa thể tạo bài nghe.' : 'The import could not finish.');
  const labels: Record<string, [string, string]> = {
    QUEUED: ['Đang chờ máy xử lý...', 'Waiting for the processor...'],
    metadata: ['Đang lấy nội dung video...', 'Retrieving the video...'],
    captions: ['Đang xử lý phụ đề...', 'Retrieving captions...'],
    caption_fallback: ['Đang kiểm tra phụ đề...', 'Checking captions...'],
    audio_download: ['Đang tải âm thanh...', 'Downloading audio...'],
    audio_decode: ['Đang chuẩn bị âm thanh...', 'Preparing audio...'],
    transcription: ['Đang nhận dạng giọng nói...', 'Transcribing speech...'],
    alignment: ['Đang đồng bộ từng từ...', 'Aligning each word...'],
    validation: ['Đang kiểm tra transcript...', 'Checking the transcript...'],
    persistence: ['Đang lưu bài nghe...', 'Saving the lesson...'],
    READY: ['Đã sẵn sàng để học!', 'Ready to study!'],
    CANCELLED: ['Đã hủy import.', 'Import cancelled.'],
  };
  return (labels[job.stage] || labels.QUEUED)[vi ? 0 : 1];
}
