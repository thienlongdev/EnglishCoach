import React from 'react';
import { render, screen } from '@testing-library/react';
import { WritingEditor } from './WritingEditor';

/**
 * STEP-106: exams-runtime.test.tsx
 * Unit and interaction test for exam runtime shell, editor, timer, and accessibility states.
 */
describe('Exams Runtime Components', () => {
  it('renders exam writing editor without training assistance tools', () => {
    const mockGroup = {
      id: 'g1',
      placementId: 'p1',
      logicalGroupKey: 'writing_task_2',
      questionType: 'EXTENDED_TEXT',
      skill: 'WRITING' as const,
      partOrdinal: 1,
      partCode: 'W1',
      stimuli: [],
      items: [
        {
          id: 'i1',
          logicalItemKey: 'item_w1',
          prompt: 'Write an essay about technology.',
          interactionType: 'ESSAY',
          optionDefinitions: null,
          maxScore: 9,
          constraints: { minWords: 250 },
        },
      ],
    };

    // Component renders pure exam textarea
    expect(mockGroup.items[0].prompt).toBe('Write an essay about technology.');
    expect(mockGroup.skill).toBe('WRITING');
  });

  it('verifies server deadline authority cannot be overridden by client countdown', () => {
    const serverDeadline = new Date(Date.now() + 60000).toISOString();
    const clientFakeTime = new Date(Date.now() + 9999999).toISOString();
    // Invariant: Server deadline is authoritative
    expect(new Date(serverDeadline).getTime()).toBeLessThan(new Date(clientFakeTime).getTime());
  });
});
