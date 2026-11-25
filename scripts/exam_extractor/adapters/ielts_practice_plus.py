"""Printed Practice Tests Plus chapters through the shared IELTS parser."""
import re
from .cambridge_ielts import CambridgeIeltsAdapter
from ..pdf_layer import Row,Token

class IeltsPracticePlusAdapter(CambridgeIeltsAdapter):
    name='ielts-practice-tests-plus'
    collections=('practice-tests-plus',)
    publisher='IELTS preparation publisher (source-pinned edition)'

    def question_documents(self,test,manifest):
        proof=test.raw.get('discovery',{})
        source=proof.get('source');digest=proof.get('sha256')
        if source and digest and any(d['path']==source and d.get('sha256')==digest for d in test.book_raw.get('source_documents',[])):
            return [source]
        return super().question_documents(test,manifest)

    def annotate(self,pages,page_w,page_h,*,question_window=False,proven_test=None):
        normalized=[]
        for page,rows in pages:
            own=[]
            for row in rows:
                text=row.text
                if row.y1<page_h*.25:
                    heading=re.fullmatch(r'(LISTENING|READING|WRITING|SPEAKING)\s+MODULE(?:\s*\([^)]*\)?)?',text,re.I)
                    badge=re.fullmatch(r'TEST\s*(\d{1,2})\s*\(Academic\s+Module\)',text,re.I)
                    if heading or badge:
                        text=heading[1].upper() if heading else 'Test '+badge[1]
                        row=Row(row.page,row.y0,row.y1,row.x0,row.x1,[Token(text,row.x0,row.x1)],row.method,row.confidence,row.column)
                own.append(row)
            normalized.append((page,own))
        return super().annotate(normalized,page_w,page_h,question_window=question_window,proven_test=proven_test)
