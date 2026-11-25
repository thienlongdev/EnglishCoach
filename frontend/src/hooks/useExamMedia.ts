import { useState, useCallback, useRef } from 'react';
import { apiClient } from '@/services/api-client';
import {
  saveAcknowledgedRecording,
  getAcknowledgedRecording,
  clearAcknowledgedRecording,
  LocalRecordingRecovery,
} from '@/lib/exams/recovery';

export interface ExamMediaState {
  recordingId: string | null;
  turnKey: string | null;
  responseId: string | null;
  isUploading: boolean;
  isSealed: boolean;
  uploadProgress: number; // 0.0 - 1.0
  acknowledgedChunkCount: number;
  acknowledgedChunks: number[];
  error: string | null;
}

export function useExamMedia(attemptId: string) {
  const [state, setState] = useState<ExamMediaState>({
    recordingId: null,
    turnKey: null,
    responseId: null,
    isUploading: false,
    isSealed: false,
    uploadProgress: 0,
    acknowledgedChunkCount: 0,
    acknowledgedChunks: [],
    error: null,
  });

  const chunkOrdinalRef = useRef(0);

  /**
   * Initialize a new recording intent on the server, binding to an active turn if provided.
   */
  const initRecording = useCallback(
    async (
      placementId: string,
      mimeType: string = 'audio/webm',
      turnKey?: string,
      commandId?: string,
      expectedAttemptRevision?: number
    ) => {
      chunkOrdinalRef.current = 0;
      setState({
        recordingId: null,
        turnKey: turnKey || null,
        responseId: null,
        isUploading: false,
        isSealed: false,
        uploadProgress: 0,
        acknowledgedChunkCount: 0,
        acknowledgedChunks: [],
        error: null,
      });

      try {
        const payload = {
          attemptId,
          placementId,
          codec: mimeType,
          deviceMeta: {
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            platform: typeof navigator !== 'undefined' ? navigator.platform : '',
          },
          turnKey,
          commandId,
          expectedAttemptRevision,
        };

        const url = turnKey
          ? `/exams/attempts/${attemptId}/speaking/turns/${encodeURIComponent(turnKey)}/recordings`
          : `/exams/attempts/${attemptId}/recordings`;

        const res = await apiClient.post(url, payload);

        const recId = res.data.recordingId;
        const respId = res.data.responseId;
        const ackCount = res.data.acknowledgedChunkCount ?? 0;

        // Persist initial unsealed state to local recovery
        if (turnKey && recId) {
          await saveAcknowledgedRecording({
            attemptId,
            turnKey,
            recordingId: recId,
            responseId: respId || null,
            acknowledgedChunks: [],
            totalBytes: 0,
            isSealed: false,
            updatedAt: Date.now(),
          });
        }

        setState((prev) => ({
          ...prev,
          recordingId: recId,
          responseId: respId || null,
          turnKey: turnKey || null,
          acknowledgedChunkCount: ackCount,
        }));
        return recId;
      } catch (err: any) {
        const msg = err?.response?.data?.message || 'Failed to initialize audio recording';
        setState((prev) => ({ ...prev, error: msg }));
        throw err;
      }
    },
    [attemptId]
  );

  /**
   * Upload an individual recording chunk with idempotency and hash verification.
   */
  const uploadChunk = useCallback(
    async (recordingId: string, sequenceNumber: number, chunkBlob: Blob, clientSha256?: string) => {
      let sha256 = clientSha256;
      if (!sha256) {
        const arrayBuffer = await chunkBlob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      }

      const res = await apiClient.put(
        `/exams/recordings/${recordingId}/chunks/${sequenceNumber}`,
        chunkBlob,
        {
          headers: {
            'Content-Type': chunkBlob.type || 'audio/webm',
            'X-Chunk-Sha256': sha256,
          },
        }
      );

      const receipt = res.data;
      const ackCount = receipt?.acknowledgedChunkCount ?? 1;

      setState((prev) => {
        const updatedChunks = prev.acknowledgedChunks.includes(sequenceNumber)
          ? prev.acknowledgedChunks
          : [...prev.acknowledgedChunks, sequenceNumber].sort((a, b) => a - b);

        if (prev.turnKey) {
          saveAcknowledgedRecording({
            attemptId,
            turnKey: prev.turnKey,
            recordingId,
            responseId: prev.responseId,
            acknowledgedChunks: updatedChunks,
            totalBytes: chunkBlob.size,
            isSealed: false,
            updatedAt: Date.now(),
          });
        }

        return {
          ...prev,
          acknowledgedChunkCount: ackCount,
          acknowledgedChunks: updatedChunks,
        };
      });

      return { sequenceNumber, sha256Hash: sha256, byteSize: chunkBlob.size, receipt };
    },
    [attemptId]
  );

  /**
   * Upload recorded audio blob to the server and seal the recording.
   */
  const uploadAndSeal = useCallback(
    async (recordingId: string, audioBlob: Blob): Promise<string> => {
      setState((prev) => ({ ...prev, isUploading: true, uploadProgress: 0.1, acknowledgedChunkCount: 0 }));

      try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

        // Upload single chunk representing full audio capture
        const chunkIndex = 0;
        const chunkRes = await apiClient.put(
          `/exams/recordings/${recordingId}/chunks/${chunkIndex}`,
          audioBlob,
          {
            headers: {
              'Content-Type': audioBlob.type || 'audio/webm',
              'X-Chunk-Sha256': sha256,
            },
          }
        );

        const ackCount = chunkRes.data?.acknowledgedChunkCount ?? 1;

        setState((prev) => ({
          ...prev,
          uploadProgress: 0.8,
          acknowledgedChunkCount: ackCount,
          acknowledgedChunks: [0],
        }));

        // Seal recording with full manifest and hash fields
        await apiClient.post(`/exams/recordings/${recordingId}/seal`, {
          manifest: [
            { sequenceNumber: 0, sha256Hash: sha256, byteSize: audioBlob.size }
          ],
          totalBytes: audioBlob.size,
          finalHash: sha256,
          totalChunks: 1,
          finalSha256: sha256,
        });

        setState((prev) => {
          if (prev.turnKey) {
            saveAcknowledgedRecording({
              attemptId,
              turnKey: prev.turnKey,
              recordingId,
              responseId: prev.responseId,
              acknowledgedChunks: [0],
              totalBytes: audioBlob.size,
              isSealed: true,
              updatedAt: Date.now(),
            });
          }
          return {
            ...prev,
            isUploading: false,
            isSealed: true,
            uploadProgress: 1.0,
          };
        });

        return recordingId;
      } catch (err: any) {
        const errCode = err?.response?.data?.errorCode || err?.response?.data?.message || '';
        if (typeof errCode === 'string' && (errCode.includes('RECORDING_ALREADY_SEALED') || errCode.includes('ALREADY_SEALED'))) {
          console.warn('Recording already sealed on server, reconciling to success:', recordingId);
          setState((prev) => ({
            ...prev,
            isUploading: false,
            isSealed: true,
            uploadProgress: 1.0,
          }));
          return recordingId;
        }
        const msg = err?.response?.data?.message || 'Failed to upload and seal audio recording';
        setState((prev) => ({ ...prev, isUploading: false, error: msg }));
        throw err;
      }
    },
    [attemptId]
  );

  /**
   * Seal a recording after all chunks have been uploaded.
   */
  const sealRecording = useCallback(
    async (
      recordingId: string,
      manifest: Array<{ sequenceNumber: number; sha256Hash: string; byteSize: number }>,
      totalBytes: number,
      finalHash: string
    ): Promise<void> => {
      setState((prev) => ({ ...prev, isUploading: true }));
      try {
        await apiClient.post(`/exams/recordings/${recordingId}/seal`, {
          manifest,
          totalBytes,
          finalHash,
          totalChunks: manifest.length,
          finalSha256: finalHash,
        });

        setState((prev) => {
          const sortedSeqs = manifest.map((m) => m.sequenceNumber).sort((a, b) => a - b);
          if (prev.turnKey) {
            saveAcknowledgedRecording({
              attemptId,
              turnKey: prev.turnKey,
              recordingId,
              responseId: prev.responseId,
              acknowledgedChunks: sortedSeqs,
              totalBytes,
              isSealed: true,
              updatedAt: Date.now(),
            });
          }
          return {
            ...prev,
            isUploading: false,
            isSealed: true,
            uploadProgress: 1.0,
            acknowledgedChunkCount: sortedSeqs.length,
            acknowledgedChunks: sortedSeqs,
          };
        });
      } catch (err: any) {
        const errCode = err?.response?.data?.errorCode || err?.response?.data?.message || '';
        if (typeof errCode === 'string' && (errCode.includes('RECORDING_ALREADY_SEALED') || errCode.includes('ALREADY_SEALED'))) {
          console.warn('Recording already sealed on server, reconciling to success:', recordingId);
          setState((prev) => ({
            ...prev,
            isUploading: false,
            isSealed: true,
            uploadProgress: 1.0,
          }));
          return;
        }
        const msg = err?.response?.data?.message || 'Failed to seal recording';
        setState((prev) => ({ ...prev, isUploading: false, error: msg }));
        throw err;
      }
    },
    [attemptId]
  );

  /**
   * Reconcile local recovery storage with truthful server recording status on load or reload.
   */
  const reconcileRecording = useCallback(
    async (turnKey: string) => {
      try {
        const local = await getAcknowledgedRecording(attemptId, turnKey);
        let recId = local?.recordingId;
        let ackChunks = local?.acknowledgedChunks || [];
        let isSealed = local?.isSealed || false;
        let respId = local?.responseId || null;
        let totalBytes = local?.totalBytes || 0;

        if (recId) {
          try {
            const res = await apiClient.get(`/exams/recordings/${recId}`);
            if (res.data) {
              recId = res.data.recordingId;
              respId = res.data.responseId || respId;
              ackChunks = res.data.acknowledgedSequences || ackChunks;
              totalBytes = res.data.totalBytes || totalBytes;
              isSealed = res.data.state === 'SEALED';

              // Sync back to local IndexedDB
              await saveAcknowledgedRecording({
                attemptId,
                turnKey,
                recordingId: recId!,
                responseId: respId,
                acknowledgedChunks: ackChunks,
                totalBytes,
                isSealed,
                updatedAt: Date.now(),
              });
            }
          } catch (err) {
            console.warn('Failed to query server recording status for reconciliation', err);
          }
        }

        setState({
          recordingId: recId || null,
          turnKey,
          responseId: respId,
          isUploading: false,
          isSealed,
          uploadProgress: isSealed ? 1.0 : (ackChunks.length > 0 ? 0.5 : 0),
          acknowledgedChunkCount: ackChunks.length,
          acknowledgedChunks: ackChunks,
          error: null,
        });

        return { recordingId: recId, turnKey, acknowledgedChunks: ackChunks, isSealed, totalBytes };
      } catch (err) {
        console.warn('Reconciliation error:', err);
        return null;
      }
    },
    [attemptId]
  );

  /**
   * Mark active recording as failed on the server and update local state.
   */
  const failActiveRecording = useCallback(
    async (recordingId: string, errorCode: string = 'UPLOAD_FAILED') => {
      try {
        await apiClient.post(`/exams/recordings/${recordingId}/fail`, { errorCode });
      } catch (err) {
        console.warn('Failed to mark recording as failed on server:', err);
      }
      setState((prev) => ({
        ...prev,
        isUploading: false,
        error: errorCode,
      }));
    },
    []
  );

  return {
    ...state,
    initRecording,
    uploadChunk,
    uploadAndSeal,
    sealRecording,
    reconcileRecording,
    failActiveRecording,
  };
}
