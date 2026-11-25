'use client';

import React from 'react';
import { FocusFace } from './FocusControls';
import { useFocus } from './data';

/** The Picture-in-Picture window's content: the same session, the same engine (same JS realm as the opener). */
export default function PipTimer() {
  const { state, engine } = useFocus();
  return (
    <div style={{ padding: 12 }}>
      <FocusFace state={state} engine={engine} size={200} compact />
      {state.label && <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, marginTop: 8, opacity: 0.8 }}>{state.label}</div>}
    </div>
  );
}
