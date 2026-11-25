import { mutate } from 'swr';
import { revalidateListeningSystemCatalog, revalidateListeningMaterialResource } from './moduleEntryResources';
import { apiClient } from './api-client';
import { ListeningMaterialSummary, ListeningMaterialDetail, ListeningLibraryItem, ListeningCategory } from '../types/listening';

// SWR cache keys are [path, userScope]; the path is also the request URL, so one
// logical resource always maps to one key.
export const LISTENING_CATEGORIES_PATH = '/listening/library/categories';
const PERSONAL_LISTENING_PATH_PREFIX = '/listening/materials?personalOnly=true';

export const buildPersonalListeningPath = (cefrLevel?: string, topic?: string, accent?: string): string => {
    const params = new URLSearchParams();
    params.append('personalOnly', 'true');
    if (cefrLevel) params.append('cefrLevel', cefrLevel);
    if (topic) params.append('topic', topic);
    if (accent) params.append('accent', accent);
    return `/listening/materials?${params.toString()}`;
};

export const fetchListeningPath = async <T>(path: string): Promise<T> => {
    const response = await apiClient.get(path);
    return response.data;
};

const isPersonalListeningKey = (key: unknown): boolean =>
    Array.isArray(key) && typeof key[0] === 'string' && key[0].startsWith(PERSONAL_LISTENING_PATH_PREFIX);

/** Revalidates every cached "Bài nghe của tôi" list (all filter combinations) from the server. */
export const revalidatePersonalListeningLibrary = () => mutate(isPersonalListeningKey);

export const getListeningLibraryCategories = async (): Promise<ListeningCategory[]> =>
    fetchListeningPath<ListeningCategory[]>(LISTENING_CATEGORIES_PATH);

export const getSharedListeningLibrary = async (): Promise<ListeningLibraryItem[]> => {
    const response = await apiClient.get('/listening/library');
    return response.data;
};

export const getPersonalListeningMaterials = async (
    cefrLevel?: string,
    topic?: string,
    accent?: string
): Promise<ListeningMaterialSummary[]> =>
    fetchListeningPath<ListeningMaterialSummary[]>(buildPersonalListeningPath(cefrLevel, topic, accent));

export const getListeningMaterials = async (
    cefrLevel?: string,
    topic?: string,
    accent?: string
): Promise<ListeningMaterialSummary[]> => {
    const params = new URLSearchParams();
    if (cefrLevel) params.append('cefrLevel', cefrLevel);
    if (topic) params.append('topic', topic);
    if (accent) params.append('accent', accent);

    // Fallback to empty string for safety if no params
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const response = await apiClient.get('/listening/materials' + queryString);
    return response.data;
};

export const getListeningMaterialById = async (id: number): Promise<ListeningMaterialDetail> => {
    const response = await apiClient.get(`/listening/materials/${id}`);
    return response.data;
};

export const getListeningExercises = async (materialId: number): Promise<import('../types/listening').ListeningExercise[]> => {
    const response = await apiClient.get(`/listening/materials/${materialId}/exercises`);
    return response.data;
};

export const submitExerciseAttempt = async (exerciseId: number, attempt: import('../types/listening').ExerciseAttemptRequest): Promise<import('../types/listening').ExerciseAttemptResponse> => {
    const response = await apiClient.post(`/listening/exercises/${exerciseId}/attempts`, attempt);
    return response.data;
};

export const getListeningDNA = async (): Promise<import('../types/listening').ErrorDNADto> => {
    const response = await apiClient.get('/listening/analytics/dna');
    return response.data;
};

export const getMaterialHeatmap = async (materialId: number): Promise<import('../types/listening').SegmentHeatmapDto[]> => {
    const response = await apiClient.get(`/listening/analytics/materials/${materialId}/heatmap`);
    return response.data;
};

export const importListeningMaterial = async (
    request: import('../types/listening').ImportListeningRequest
): Promise<ListeningMaterialDetail> => {
    const response = await apiClient.post('/listening/import', request);
    void revalidateListeningMaterialResource();
    return response.data;
};

export const deleteListeningMaterial = async (id: number): Promise<void> => {
    await apiClient.delete(`/listening/materials/${id}`);
    void revalidateListeningMaterialResource();
    void revalidateListeningSystemCatalog();
};

export const completeListeningSession = async (sessionId: number): Promise<void> => {
    await apiClient.post(`/listening/sessions/${sessionId}/complete`);
};

export const importSystemListeningMaterial = async (
    request: import('../types/listening').ImportListeningRequest
): Promise<ListeningMaterialDetail> => {
    const response = await apiClient.post('/listening/system/import', request);
    void revalidateListeningSystemCatalog();
    void revalidateListeningMaterialResource();
    return response.data;
};

