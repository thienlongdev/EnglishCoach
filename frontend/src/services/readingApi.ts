import { apiClient } from './api-client';
import { ReadingMaterial } from '@/components/features/reading/ReadingCard';

export const getReadingMaterials = async (): Promise<ReadingMaterial[]> => {
    const { data } = await apiClient.get<ReadingMaterial[]>('/reading/materials');
    return data || [];
};

export const deleteReadingMaterial = async (id: number): Promise<void> => {
    await apiClient.delete(`/reading/materials/${id}`);
};

/** Server record of one learner's reading of a material (no AI, no percentage from the client). */
export interface ReadingCompletionState {
    materialId: number;
    completed: boolean;
    completedAt: string | null;
    minSeconds: number;
}

/** Opening the reader: the server records when this reading began and says whether the material is already read. */
export const openReadingSession = async (id: number): Promise<ReadingCompletionState> =>
    (await apiClient.post<ReadingCompletionState>(`/reading/materials/${encodeURIComponent(String(id))}/session`)).data;

/** "Hoàn thành bài đọc": accepted after a server-measured reading time; 409 READING_TOO_FAST before that. */
export const completeReading = async (id: number): Promise<ReadingCompletionState> =>
    (await apiClient.post<ReadingCompletionState>(`/reading/materials/${encodeURIComponent(String(id))}/complete`)).data;
