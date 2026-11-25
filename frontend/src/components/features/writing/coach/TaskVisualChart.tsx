'use client';

import React from 'react';

export interface VisualData {
  chartType?: 'line' | 'bar' | 'pie' | 'table' | 'process' | 'map' | 'mixed';
  title?: string;
  unit?: string;
  xAxis?: {
    label?: string;
    categories: string[];
  };
  yAxis?: {
    label?: string;
    min?: number;
    max?: number;
  };
  series?: Array<{
    name: string;
    color: string;
    data: number[];
  }>;
  subCharts?: Array<{
    title: string;
    slices: Array<{
      name: string;
      value: number;
      color: string;
    }>;
  }>;
  columns?: string[];
  rows?: string[][];
  steps?: Array<{
    stage: number;
    label: string;
    desc: string;
  }>;
  features?: Array<{
    zone: string;
    before: string;
    after: string;
  }>;
  chartPart?: {
    type: string;
    title: string;
    categories: string[];
    values: number[];
    unit: string;
  };
  tablePart?: {
    title: string;
    columns: string[];
    rows: string[][];
  };
}

interface TaskVisualChartProps {
  visualData?: VisualData | null;
  className?: string;
}

export const TaskVisualChart: React.FC<TaskVisualChartProps> = ({ visualData, className = '' }) => {
  if (!visualData) return null;

  const { chartType = 'line', title } = visualData;

  return (
    <div className={`rounded-xl border border-surface-container-high/80 bg-surface-container-lowest p-4 shadow-xs overflow-hidden ${className}`}>
      {title && (
        <div className="mb-3 flex items-center justify-between border-b border-surface-container-high/60 pb-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[18px]">
              {chartType === 'line' ? 'show_chart' :
               chartType === 'bar' ? 'bar_chart' :
               chartType === 'pie' ? 'pie_chart' :
               chartType === 'table' ? 'table_chart' :
               chartType === 'process' ? 'account_tree' :
               chartType === 'map' ? 'map' : 'analytics'}
            </span>
            <h4 className="font-headline-sm text-xs font-bold text-on-surface uppercase tracking-wide">
              {title}
            </h4>
          </div>
          {visualData.unit && (
            <span className="text-[11px] font-medium text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">
              Đơn vị: {visualData.unit}
            </span>
          )}
        </div>
      )}

      {chartType === 'line' && renderLineChart(visualData)}
      {chartType === 'bar' && renderBarChart(visualData)}
      {chartType === 'pie' && renderPieChart(visualData)}
      {chartType === 'table' && renderTable(visualData)}
      {chartType === 'process' && renderProcess(visualData)}
      {chartType === 'map' && renderMap(visualData)}
      {chartType === 'mixed' && renderMixed(visualData)}
    </div>
  );
};

function renderLineChart(data: VisualData) {
  const { xAxis, yAxis, series = [] } = data;
  const categories = xAxis?.categories || [];
  const yMax = yAxis?.max || 100;
  const yMin = yAxis?.min || 0;

  const width = 460;
  const height = 200;
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 30;

  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const getX = (idx: number) => padL + (idx / Math.max(categories.length - 1, 1)) * plotW;
  const getY = (val: number) => padT + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-[500px] h-auto text-xs">
          {/* Y Axis Gridlines & Labels */}
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = getY(tick);
            return (
              <g key={tick}>
                <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                <text x={padL - 6} y={y + 4} textAnchor="end" fill="#64748b" fontSize="10">
                  {tick}%
                </text>
              </g>
            );
          })}

          {/* X Axis & Labels */}
          <line x1={padL} y1={height - padB} x2={width - padR} y2={height - padB} stroke="#94a3b8" />
          {categories.map((cat, idx) => {
            const x = getX(idx);
            return (
              <text key={idx} x={x} y={height - padB + 16} textAnchor="middle" fill="#475569" fontSize="11" fontWeight="600">
                {cat}
              </text>
            );
          })}

          {/* Series Lines & Points */}
          {series.map((s, sIdx) => {
            const points = s.data.map((val, idx) => `${getX(idx)},${getY(val)}`).join(' ');
            return (
              <g key={sIdx}>
                <polyline
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={points}
                />
                {s.data.map((val, idx) => {
                  const cx = getX(idx);
                  const cy = getY(val);
                  return (
                    <g key={idx}>
                      <circle cx={cx} cy={cy} r="4" fill={s.color} stroke="#ffffff" strokeWidth="1.5" />
                      <text x={cx} y={cy - 7} textAnchor="middle" fill={s.color} fontSize="9" fontWeight="bold">
                        {val}%
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 justify-center border-t border-surface-container-high/40 pt-2">
        {series.map((s, idx) => (
          <div key={idx} className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderBarChart(data: VisualData) {
  const { xAxis, yAxis, series = [] } = data;
  const categories = xAxis?.categories || [];
  const yMax = yAxis?.max || 800;

  const width = 480;
  const height = 210;
  const padL = 40;
  const padR = 20;
  const padT = 25;
  const padB = 30;

  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const groupWidth = plotW / Math.max(categories.length, 1);
  const barWidth = Math.min(18, (groupWidth - 12) / Math.max(series.length, 1));

  const getY = (val: number) => padT + plotH - (val / yMax) * plotH;

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-[520px] h-auto text-xs">
          {/* Y Axis Gridlines */}
          {[0, 200, 400, 600, 800].map((tick) => {
            const y = getY(tick);
            return (
              <g key={tick}>
                <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                <text x={padL - 6} y={y + 4} textAnchor="end" fill="#64748b" fontSize="10">
                  {tick}
                </text>
              </g>
            );
          })}

          <line x1={padL} y1={height - padB} x2={width - padR} y2={height - padB} stroke="#94a3b8" />

          {/* Bars grouped by category */}
          {categories.map((cat, cIdx) => {
            const groupX = padL + cIdx * groupWidth + (groupWidth - series.length * barWidth) / 2;
            return (
              <g key={cIdx}>
                {series.map((s, sIdx) => {
                  const val = s.data[cIdx] || 0;
                  const bx = groupX + sIdx * barWidth;
                  const by = getY(val);
                  const bh = height - padB - by;
                  return (
                    <g key={sIdx}>
                      <rect x={bx} y={by} width={barWidth - 2} height={bh} rx="2" fill={s.color} />
                      <text x={bx + (barWidth - 2) / 2} y={by - 4} textAnchor="middle" fill="#334155" fontSize="8" fontWeight="600">
                        {val}
                      </text>
                    </g>
                  );
                })}
                <text x={padL + (cIdx + 0.5) * groupWidth} y={height - padB + 16} textAnchor="middle" fill="#475569" fontSize="10" fontWeight="600">
                  {cat}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap gap-4 justify-center border-t border-surface-container-high/40 pt-2">
        {series.map((s, idx) => (
          <div key={idx} className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
            <span className="w-3 h-3 rounded-xs shrink-0" style={{ backgroundColor: s.color }} />
            <span>Năm {s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderPieChart(data: VisualData) {
  const { subCharts = [] } = data;

  return (
    <div className="flex flex-wrap gap-4 sm:gap-6 justify-around items-center py-2 w-full">
      {subCharts.map((sub, idx) => {
        let cumulativePercent = 0;
        const slices = sub.slices.map((slice) => {
          const start = cumulativePercent;
          cumulativePercent += slice.value;
          return { ...slice, start, end: cumulativePercent };
        });

        return (
          <div key={idx} className="flex flex-col items-center gap-2 min-w-0 max-w-full">
            <span className="text-xs font-bold text-on-surface uppercase tracking-wide text-center">
              {sub.title}
            </span>
            <div className="relative w-32 h-32 sm:w-36 sm:h-36 max-w-full aspect-square">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                {slices.map((slice, sIdx) => {
                  const startAngle = (slice.start / 100) * 2 * Math.PI;
                  const endAngle = (slice.end / 100) * 2 * Math.PI;
                  const x1 = 50 + 40 * Math.cos(startAngle);
                  const y1 = 50 + 40 * Math.sin(startAngle);
                  const x2 = 50 + 40 * Math.cos(endAngle);
                  const y2 = 50 + 40 * Math.sin(endAngle);
                  const largeArc = slice.value > 50 ? 1 : 0;
                  const d = `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`;

                  return (
                    <path
                      key={sIdx}
                      d={d}
                      fill={slice.color}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                    />
                  );
                })}
              </svg>
            </div>

            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] pt-1 max-w-full">
              {sub.slices.map((s, sIdx) => (
                <div key={sIdx} className="flex items-center gap-1 text-on-surface whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                  <span>{s.name}: <b>{s.value}%</b></span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderTable(data: VisualData) {
  const { columns = [], rows = [] } = data;

  return (
    <div className="overflow-x-auto rounded-lg border border-surface-container-high/60">
      <table className="w-full text-xs text-left border-collapse">
        <thead>
          <tr className="bg-surface-container border-b border-surface-container-high">
            {columns.map((col, idx) => (
              <th key={idx} className="py-2.5 px-3 font-bold text-on-surface tracking-wider">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-container-high/40 bg-surface-container-lowest">
          {rows.map((row, rIdx) => (
            <tr key={rIdx} className={rIdx % 2 === 0 ? 'bg-surface-container-lowest' : 'bg-surface-container-low/50'}>
              {row.map((cell, cIdx) => (
                <td key={cIdx} className={`py-2 px-3 text-on-surface ${cIdx === 0 ? 'font-bold' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderProcess(data: VisualData) {
  const { steps = [] } = data;

  return (
    <div className="flex flex-col gap-2.5 py-1">
      {steps.map((st, idx) => (
        <div key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-surface-container-low border border-surface-container-high/60">
          <div className="w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center font-bold text-xs shrink-0 shadow-2xs">
            {st.stage}
          </div>
          <div className="flex-1">
            <h5 className="font-bold text-xs text-on-surface">{st.label}</h5>
            <p className="text-[11px] text-on-surface-variant mt-0.5 leading-relaxed">{st.desc}</p>
          </div>
          {idx < steps.length - 1 && (
            <span className="material-symbols-outlined text-outline text-[16px] self-center shrink-0">
              arrow_downward
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function renderMap(data: VisualData) {
  const { features = [] } = data;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 py-1">
      {features.map((f, idx) => (
        <div key={idx} className="p-3 rounded-lg bg-surface-container-low border border-surface-container-high/60 space-y-2">
          <div className="flex items-center gap-1.5 border-b border-surface-container-high/60 pb-1.5">
            <span className="material-symbols-outlined text-primary text-[16px]">location_on</span>
            <span className="font-bold text-xs text-on-surface">{f.zone}</span>
          </div>
          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-start gap-1 text-on-surface-variant">
              <span className="font-bold text-amber-700 dark:text-amber-400 shrink-0">Năm 2000:</span>
              <span>{f.before}</span>
            </div>
            <div className="flex items-start gap-1 text-on-surface">
              <span className="font-bold text-emerald-700 dark:text-emerald-400 shrink-0">Năm 2025:</span>
              <span className="font-medium">{f.after}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function renderMixed(data: VisualData) {
  const { chartPart, tablePart } = data;

  return (
    <div className="space-y-4">
      {chartPart && (
        <div className="space-y-2">
          <h5 className="text-xs font-bold text-on-surface">{chartPart.title}</h5>
          <div className="space-y-1.5">
            {chartPart.categories.map((cat, idx) => {
              const val = chartPart.values[idx] || 0;
              return (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  <span className="w-28 text-on-surface-variant truncate shrink-0">{cat}</span>
                  <div className="flex-1 bg-surface-container h-4 rounded-full overflow-hidden">
                    <div
                      className="bg-primary h-full rounded-full flex items-center justify-end pr-2 text-[9px] text-white font-bold"
                      style={{ width: `${val}%` }}
                    >
                      {val}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tablePart && (
        <div className="space-y-2 pt-2 border-t border-surface-container-high/60">
          <h5 className="text-xs font-bold text-on-surface">{tablePart.title}</h5>
          <div className="overflow-x-auto rounded-lg border border-surface-container-high/60">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-surface-container border-b border-surface-container-high">
                  {tablePart.columns.map((col, idx) => (
                    <th key={idx} className="py-1.5 px-2.5 font-bold text-on-surface">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-high/40">
                {tablePart.rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className={`py-1.5 px-2.5 ${cIdx === 0 ? 'font-bold' : ''}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
