"use client";
import React, { useState } from "react";
import { DictionaryPopup } from "./DictionaryPopup";

export function InteractiveText({ text, className = "" }: { text: string; className?: string }) {
    const [selectedWord, setSelectedWord] = useState<string | null>(null);
    const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });

    const handleWordClick = (e: React.MouseEvent, word: string) => {
        const cleanWord = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
        if (cleanWord.length > 1) {
            setPopupPos({ top: e.pageY + 10, left: e.pageX - 150 });
            setSelectedWord(cleanWord);
        }
    };

    return (
        <>
            <div className={`leading-relaxed ${className}`}>
                {text.split(" ").map((word, i) => (
                    <span
                        key={i}
                        onClick={(e) => handleWordClick(e, word)}
                        className="cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900 hover:text-blue-700 transition-colors duration-150 inline-block mr-1"
                    >
                        {word}
                    </span>
                ))}
            </div>

            {selectedWord && (
                <div style={{ position: "absolute", top: popupPos.top, left: popupPos.left, zIndex: 50 }}>
                    <DictionaryPopup word={selectedWord} onClose={() => setSelectedWord(null)} />
                </div>
            )}
        </>
    );
}
