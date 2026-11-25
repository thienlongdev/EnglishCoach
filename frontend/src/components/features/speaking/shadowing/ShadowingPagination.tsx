"use client";

import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./shadowingLibrary.module.css";

export type PaginationSlot = number | "ellipsis-start" | "ellipsis-end";

/**
 * Deterministic 1-based page slot builder with clean ellipsis for large page counts.
 * Always keeps page 1 and totalPages reachable in a single click.
 */
export function buildPaginationItems(currentPage: number, totalPages: number): PaginationSlot[] {
    const safeTotal = Math.max(1, Math.floor(totalPages || 1));
    const safeCurrent = Math.max(1, Math.min(safeTotal, Math.floor(currentPage || 1)));

    if (safeTotal <= 7) {
        return Array.from({ length: safeTotal }, (_, idx) => idx + 1);
    }

    if (safeCurrent <= 4) {
        return [1, 2, 3, 4, 5, "ellipsis-end", safeTotal];
    }

    if (safeCurrent >= safeTotal - 3) {
        return [
            1,
            "ellipsis-start",
            safeTotal - 4,
            safeTotal - 3,
            safeTotal - 2,
            safeTotal - 1,
            safeTotal,
        ];
    }

    return [
        1,
        "ellipsis-start",
        safeCurrent - 1,
        safeCurrent,
        safeCurrent + 1,
        "ellipsis-end",
        safeTotal,
    ];
}

export interface ShadowingPaginationProps {
    currentPage: number; // 1-based
    totalPages: number;
    totalElements: number;
    pageSize: number;
    currentItemCount: number;
    disabled?: boolean;
    vi?: boolean;
    onPageChange: (page: number) => void;
}

export function ShadowingPagination({
    currentPage,
    totalPages,
    totalElements,
    pageSize,
    currentItemCount,
    disabled = false,
    vi = true,
    onPageChange,
}: ShadowingPaginationProps) {
    if (totalElements <= 0) {
        return null;
    }

    const safeTotalPages = Math.max(1, totalPages);
    const safePage = Math.max(1, Math.min(safeTotalPages, currentPage));
    const rangeStart = currentItemCount > 0 ? (safePage - 1) * pageSize + 1 : 0;
    const rangeEnd = currentItemCount > 0 ? Math.min(totalElements, rangeStart + currentItemCount - 1) : 0;
    const slots = buildPaginationItems(safePage, safeTotalPages);

    const canPrev = !disabled && safePage > 1;
    const canNext = !disabled && safePage < safeTotalPages;

    return (
        <nav
            className={styles.pagination}
            aria-label={vi ? "Phân trang thư viện Shadowing" : "Shadowing library pagination"}
            data-testid="shadowing-pagination"
        >
            <div className={styles.pageMeta} role="status" aria-live="polite">
                <span className={styles.pageBadge} data-testid="shadowing-page-readout">
                    {vi ? `Trang ${safePage} / ${safeTotalPages}` : `Page ${safePage} of ${safeTotalPages}`}
                </span>
                <span data-testid="shadowing-total-readout">
                    {rangeStart > 0 ? (
                        vi ? (
                            <>
                                Hiển thị <strong>{rangeStart}–{rangeEnd}</strong> trong tổng số <strong>{totalElements}</strong> bài luyện
                            </>
                        ) : (
                            <>
                                Showing <strong>{rangeStart}–{rangeEnd}</strong> of <strong>{totalElements}</strong> lessons
                            </>
                        )
                    ) : vi ? (
                        <>Tổng số <strong>{totalElements}</strong> bài luyện</>
                    ) : (
                        <><strong>{totalElements}</strong> total lessons</>
                    )}
                </span>
            </div>

            <div className={styles.pageControls}>
                <button
                    type="button"
                    data-testid="shadowing-page-prev"
                    onClick={() => canPrev && onPageChange(safePage - 1)}
                    disabled={!canPrev}
                    className={`${styles.pageBtn} ${styles.navBtn}`}
                    aria-label={vi ? "Trang trước" : "Previous page"}
                >
                    <ChevronLeft aria-hidden="true" />
                    <span className={styles.navLabel}>{vi ? "Trước" : "Previous"}</span>
                </button>

                {slots.map((slot) => {
                    if (slot === "ellipsis-start" || slot === "ellipsis-end") {
                        return (
                            <span key={slot} className={styles.ellipsis} aria-hidden="true">
                                …
                            </span>
                        );
                    }
                    const isActive = slot === safePage;
                    return (
                        <button
                            key={slot}
                            type="button"
                            data-testid={`shadowing-page-num-${slot}`}
                            onClick={() => {
                                if (!disabled && !isActive) {
                                    onPageChange(slot);
                                }
                            }}
                            disabled={disabled}
                            aria-current={isActive ? "page" : undefined}
                            aria-label={vi ? `Đến trang ${slot}` : `Go to page ${slot}`}
                            className={styles.pageBtn}
                        >
                            {slot}
                        </button>
                    );
                })}

                <button
                    type="button"
                    data-testid="shadowing-page-next"
                    onClick={() => canNext && onPageChange(safePage + 1)}
                    disabled={!canNext}
                    className={`${styles.pageBtn} ${styles.navBtn}`}
                    aria-label={vi ? "Trang sau" : "Next page"}
                >
                    <span className={styles.navLabel}>{vi ? "Sau" : "Next"}</span>
                    <ChevronRight aria-hidden="true" />
                </button>
            </div>
        </nav>
    );
}

export default ShadowingPagination;
