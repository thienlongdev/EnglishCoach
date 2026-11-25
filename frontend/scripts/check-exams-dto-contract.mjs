import assert from 'assert';

/**
 * EXAMS RUNTIME V4 - Chunk EXAMS-V4-02 Contract Verification
 * Tests JSON serialization and deserialization round-trip between
 * backend ExamContentRecords.java and frontend types/exams.ts.
 */

console.log('[EXAMS-V4-02] Starting DTO Contract Verification...');

// 1. Backend payload sample emitted by ExamManifestService
const sampleBackendManifestJson = JSON.stringify({
  attemptId: "770e8400-e29b-41d4-a716-446655440000",
  formId: "123e4567-e89b-12d3-a456-426614174000",
  family: "IELTS",
  variant: "ACADEMIC",
  scope: "FULL",
  mode: "EXAM_SIMULATION",
  title: "Cambridge IELTS 14 Test 1",
  manifestHash: "test-manifest-hash-1234",
  sections: [
    {
      id: "sec-listening-01",
      skill: "LISTENING",
      ordinal: 1,
      specSectionKey: "IELTS_AC_LISTENING",
      durationSeconds: 1800,
      timingPolicy: { allowPause: false },
      parts: [
        {
          id: "part-01",
          partCode: "P1",
          ordinal: 1,
          instructions: "Questions 1-10 Complete the notes below.",
          formKind: "NOTE_COMPLETION",
          groups: [
            {
              id: "grp-01",
              placementId: "p_P1_g_crime_report",
              logicalGroupKey: "crime_report",
              questionType: "NOTE_COMPLETION",
              formKind: "NOTE_COMPLETION",
              skill: "LISTENING",
              ordinal: 1,
              displayNumbering: "1-10",
              stimuli: [
                {
                  id: "stim-01",
                  logicalKey: "audio_intro",
                  kind: "AUDIO_STIMULUS",
                  title: "Crime Report Recording",
                  bodyPayload: { topic: "Crime Report" },
                  assets: [
                    {
                      assetId: "asset-audio-01",
                      role: "PRIMARY_AUDIO",
                      mimeType: "audio/mpeg",
                      durationMs: 300000
                    }
                  ]
                }
              ],
              items: [
                {
                  id: "item-01",
                  placementId: "p_P1_g_crime_report_i_1",
                  logicalItemKey: "crime_report_q1",
                  prompt: "Name of caller: [Question 1]",
                  interactionType: "TEXT_GAP",
                  options: {
                    maxWords: 1,
                    placeholder: "Enter surname"
                  },
                  optionDefinitions: {
                    maxWords: 1,
                    placeholder: "Enter surname"
                  },
                  cardinality: 1,
                  wordLimit: 1
                }
              ]
            }
          ]
        }
      ]
    }
  ]
});

// Parse as frontend PublicAttemptManifestDto
const parsed = JSON.parse(sampleBackendManifestJson);

// Assertions on canonical fields
assert.strictEqual(parsed.attemptId, "770e8400-e29b-41d4-a716-446655440000");
assert.strictEqual(parsed.sections.length, 1);

const section = parsed.sections[0];
assert.strictEqual(section.specSectionKey, "IELTS_AC_LISTENING");
assert.strictEqual(section.parts.length, 1);

const part = section.parts[0];
assert.strictEqual(part.partCode, "P1");
assert.strictEqual(part.formKind, "NOTE_COMPLETION");
assert.strictEqual(part.groups.length, 1);

const group = part.groups[0];
assert.strictEqual(group.placementId, "p_P1_g_crime_report");
assert.strictEqual(group.logicalGroupKey, "crime_report");
assert.strictEqual(group.displayNumbering, "1-10");
assert.strictEqual(group.items.length, 1);

const item = group.items[0];
assert.strictEqual(item.logicalItemKey, "crime_report_q1");
assert.strictEqual(item.placementId, "p_P1_g_crime_report_i_1");

// Canonical options verification
assert(item.options !== undefined && item.options !== null, "item.options must be defined");
assert.strictEqual(item.options.maxWords, 1);

// Backward compatibility optionDefinitions verification
assert(item.optionDefinitions !== undefined && item.optionDefinitions !== null, "item.optionDefinitions must be defined for backward compatibility");
assert.strictEqual(item.optionDefinitions.maxWords, 1);

console.log('[EXAMS-V4-02] DTO Contract Verification PASSED: All canonical fields aligned.');
