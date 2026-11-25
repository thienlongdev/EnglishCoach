'use client';

import React from 'react';
import { FocusFace } from './FocusControls';
import { useFocus } from './data';

/** `/study-space/timer`: the popup window of the focus timer for browsers without Document Picture-in-Picture. */
export default function TimerWindow() {
  const { state, engine } = useFocus();
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(160deg,#f6f4ff,#e7ecff)', color: '#23264a' }} data-testid="timer-window">
      <div>
        <FocusFace state={state} engine={engine} size={220} />
        {state.label && <p style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, opacity: 0.8 }}>{state.label}</p>}
      </div>
    </div>
  );
}
