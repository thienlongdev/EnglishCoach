import { apiClient } from './api-client';
import type { ListeningDocumentJob } from '@/types/listening';

export async function extractListeningDocument(file: File, title: string, signal?: AbortSignal) {
    const form = new FormData(); form.append('file', file); form.append('title', title);
    return (await apiClient.post<{text: string}>('/listening/documents/extract', form, {signal, timeout: 130000})).data.text;
}
export async function createListeningDocument(title: string, text: string, voiceId: string, signal?: AbortSignal) {
    return (await apiClient.post<ListeningDocumentJob>('/listening/documents', {title,text,voiceId}, {signal,timeout:15000})).data;
}
export async function getListeningDocumentJob(id: string, signal?: AbortSignal) {
    return (await apiClient.get<ListeningDocumentJob>(`/listening/documents/${encodeURIComponent(id)}`, {signal,timeout:15000})).data;
}
