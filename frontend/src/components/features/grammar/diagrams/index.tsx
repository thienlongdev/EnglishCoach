'use client';

import React from 'react';
import type { DiagramSpec } from '@/types/grammar';
import { Figure } from './shared';
import { AgentDiagram } from './Agent';
import { BranchDiagram } from './Branch';
import { ClausesDiagram } from './Clauses';
import { FlowDiagram } from './Flow';
import { MatrixDiagram } from './Matrix';
import { ReferenceDiagram } from './Reference';
import { ScaleDiagram } from './Scale';
import { SlotsDiagram } from './Slots';
import { TimelineDiagram } from './Timeline';
import { TransformDiagram } from './Transform';
import { TreeDiagram } from './Tree';

export { Figure } from './shared';
export { WordMorph } from './WordMorph';
export { TimelineDiagram, TreeDiagram, TransformDiagram, BranchDiagram, AgentDiagram, ReferenceDiagram, ScaleDiagram, SlotsDiagram, ClausesDiagram, MatrixDiagram, FlowDiagram };

/** The diagram body for a spec, without the figure frame (for screens that frame it themselves, such as the Lab). */
export function DiagramBody({ spec }: { spec: DiagramSpec }) {
  switch (spec.kind) {
    case 'timeline': return <TimelineDiagram spec={spec} />;
    case 'tree': return <TreeDiagram spec={spec} />;
    case 'transform': return <TransformDiagram spec={spec} />;
    case 'branch': return <BranchDiagram spec={spec} />;
    case 'agent': return <AgentDiagram spec={spec} />;
    case 'reference': return <ReferenceDiagram spec={spec} />;
    case 'scale': return <ScaleDiagram spec={spec} />;
    case 'slots': return <SlotsDiagram spec={spec} />;
    case 'clauses': return <ClausesDiagram spec={spec} />;
    case 'matrix': return <MatrixDiagram spec={spec} />;
    case 'flow': return <FlowDiagram spec={spec} />;
    default: return null;
  }
}

/** One diagram of the lesson: a figure with its caption and the author's text alternative. */
export function Diagram({ spec, caption, alt }: { spec: DiagramSpec; caption?: string; alt?: string }) {
  return (
    <Figure kind={spec.kind} caption={caption} alt={alt}>
      <DiagramBody spec={spec} />
    </Figure>
  );
}

export default Diagram;
