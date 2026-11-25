import { apiClient } from './api-client';
import type { ListeningCheckpoint, ListeningWorkspaceState } from '@/types/listening';

export const getListeningCheckpoint = async (id: number): Promise<ListeningCheckpoint> =>
    (await apiClient.get(`/listening/materials/${id}/progress`)).data;
export const saveListeningCheckpoint = async (id: number, contentVersion: string, revision: number, state: ListeningWorkspaceState): Promise<ListeningCheckpoint> =>
    (await apiClient.put(`/listening/materials/${id}/progress`, { contentVersion, revision, state })).data;
export interface ListeningTranslations { contentVersion: string; translations: Record<string, string> }
export const getListeningTranslations = async (id: number): Promise<ListeningTranslations> =>
    (await apiClient.get(`/listening/materials/${id}/translations`)).data;
/** Stores Vietnamese pairs made on this device (free engines only); the server never runs a translation. */
export const saveListeningTranslations = async (id: number, contentVersion: string, engine: 'chrome-translator' | 'opus-mt-en-vi', translations: Record<string, string>): Promise<ListeningTranslations> =>
    (await apiClient.post(`/listening/materials/${id}/translations`, { contentVersion, engine, translations })).data;
