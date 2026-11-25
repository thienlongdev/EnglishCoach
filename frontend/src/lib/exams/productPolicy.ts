export function activeLearnerForm(form: { family: string; variant: string; skills?: string[] }): boolean {
  if (form.family !== 'TOEIC') return true;
  return !['SPEAKING', 'WRITING', 'SUITE'].includes(form.variant) && !!form.skills?.length && form.skills.every(
    (skill) => skill === 'LISTENING' || skill === 'READING');
}

export function retiredToeicAttempt(attempt: { family: string; variant?: string }): boolean {
  return attempt.family === 'TOEIC' && ['SPEAKING', 'WRITING', 'SUITE'].includes(attempt.variant || '');
}
