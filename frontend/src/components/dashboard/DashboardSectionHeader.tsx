"use client";

import React from "react";
import styles from "./dashboard.module.css";

/** Shared header of the dashboard sections (eyebrow · title · lead). */
export function DashboardSectionHeader({ eyebrow, title, lead, aside, id }: {
  eyebrow: string;
  title: string;
  lead?: string;
  aside?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="ec-wp-plate min-w-0 space-y-1.5">
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h2 id={id} className={styles.sectionTitle}>{title}</h2>
        {lead && <p className={styles.sectionLead}>{lead}</p>}
      </div>
      {aside}
    </div>
  );
}
