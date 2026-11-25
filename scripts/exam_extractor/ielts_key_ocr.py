"""Printed IELTS key prefixes: geometry selects ink; independent reads supply digits."""
import re
from dataclasses import replace
from statistics import median
from .pdf_layer import Row, Token


_ENUM_KEY = re.compile(r'^(NOT GIVEN|TRUE|FALSE|YES|NO)(?:\s|$)')


def _enum_span(row):
    match=_ENUM_KEY.match(' '.join(t.text for t in row.tokens[1:]))
    if not match:return None
    remaining=len(match[1]);last=None
    for token in row.tokens[1:]:
        remaining-=len(token.text)+1;last=token.x1
        if remaining<=0:break
    return last


def recover_merged_roman_key_rows(layer, rows, cache, log, scope, _kind='ROMAN', question_kinds=None):
    """Split merged heading-key baselines only from own ink and agreeing reads."""
    import numpy as np
    from .ocr_engine import render_region
    repaired=0
    for row in list(rows):
        if row.method!='OCR' or len(row.tokens)<2:
            continue
        prefix=row.tokens[0]
        peers=[r for r in rows if r is not row and r.page==row.page and len(r.tokens)>=2
               and re.fullmatch(r'\d{1,2}',r.tokens[0].text)
               and ((len(r.tokens)==2 and re.fullmatch(r'(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)',r.tokens[1].text))
                    if _kind=='ROMAN' else _enum_span(r) is not None)
               and abs(r.tokens[0].x0-prefix.x0)<.5*(r.y1-r.y0)]
        if len(peers)<3:
            continue
        height=median(r.y1-r.y0 for r in peers)
        if not 1.6*height<row.y1-row.y0<3.5*height:
            continue
        answer_x=median(r.tokens[1].x0 for r in peers)
        answer_right=(max(r.tokens[1].x1 for r in peers) if _kind=='ROMAN'
                      else median(_enum_span(r) for r in peers))+.4*height
        box=(max(0,prefix.x0-.2*height),row.y0,min(prefix.x1+.2*height,answer_x-.5*height),row.y1)
        ink=render_region(layer,row.page,box,300)
        dark=(ink.mean(axis=2) if ink.ndim==3 else ink)<160
        ys=np.flatnonzero(dark.any(axis=1))
        if not len(ys):continue
        bands=[];start=last=int(ys[0]);scale=300/72
        for y in ys[1:]:
            if y-last>.2*height*scale:
                bands.append((start,last+1));start=int(y)
            last=int(y)
        bands.append((start,last+1))
        # A crop ending inside the next existing baseline can contain a tiny
        # clipped edge fragment. It cannot supply a new ordinal.
        bands=[(a,b) for a,b in bands if not ((a==0 or b==dark.shape[0]) and (b-a)/scale<.1*height)]
        if len(bands)!=2 or any(not .5*height<(b-a)/scale<1.3*height for a,b in bands):
            continue
        recovered=[]
        for a,b in bands:
            y0=box[1]+a/scale-.15*height;y1=box[1]+b/scale+.15*height
            number_box=(max(0,prefix.x0-.4*height),y0,min(prefix.x1+.4*height,answer_x-.5*height),y1)
            answer_box=(answer_x-.25*height,y0,answer_right,y1)
            values=[]
            letters='IVXivx' if _kind=='ROMAN' else 'ABCDEFGHIJKLMNOPQRSTUVWXYZ '
            for crop,allow in ((number_box,'0123456789'),(answer_box,letters)):
                agreed=[]
                for dpi in (300,600):
                    agreed=[]
                    for prep in ('P0','P2'):
                        result=cache.recognize(layer,row.page,crop,dpi=dpi,pipeline=prep,allowlist=allow,boxes_pt=[crop])
                        if not result or len(result.words)!=1 or result.words[0].conf<.85:break
                        text=result.words[0].text.strip()
                        text=text.lower() if allow=='IVXivx' else text
                        if allow==letters and _kind!='ROMAN':
                            text='NOT GIVEN' if re.sub(r'\s+','',text)=='NOTGIVEN' else text
                        agreed.append(text)
                    if len(agreed)==2 and agreed[0]==agreed[1]:break
                if len(agreed)!=2 or agreed[0]!=agreed[1]:break
                values.append(agreed[0])
            if len(values)!=2 or not re.fullmatch(r'\d{1,2}',values[0]) or not 1<=int(values[0])<=40 or not (
                    re.fullmatch(r'(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)',values[1]) if _kind=='ROMAN'
                    else re.fullmatch(r'NOT GIVEN|TRUE|FALSE|YES|NO',values[1])):
                break
            recovered.append(Row(row.page,y0,y1,prefix.x0,answer_box[2],
                [Token(values[0],prefix.x0,prefix.x1),Token(values[1],answer_x,answer_box[2])],'OCR',column=row.column))
        if len(recovered)!=2 or int(recovered[1].tokens[0].text)!=int(recovered[0].tokens[0].text)+1:
            continue
        if question_kinds is not None:
            allowed={'HEADING_MATCHING'} if _kind=='ROMAN' else {'TFNG','YNNG'}
            if any(question_kinds.get(int(r.tokens[0].text)) not in allowed for r in recovered):
                continue
        if any(r.page==row.page and r is not row and abs(r.x0-prefix.x0)<height
               and any(min(r.y1,own.y1)-max(r.y0,own.y0)>.5*height for own in recovered) for r in rows):
            continue
        at=rows.index(row);rows[at:at+1]=recovered;repaired+=1
        log.add('ANSWER_KEY_OCR_REPAIRED',scope,'two own ink baselines; agreeing own ordinal and typed key reads',
            pages=str(row.page),questions='-'.join(r.tokens[0].text for r in recovered),severity='INFO')
    return repaired


def recover_merged_enum_key_rows(layer,rows,cache,log,scope,question_kinds=None):
    return recover_merged_roman_key_rows(layer,rows,cache,log,scope,_kind='ENUM',question_kinds=question_kinds)


def reread_typed_key_values(layer,rows,cache,log,scope,question_kinds=None):
    """Remove adjacent OCR debris only after reading the own ordinal and complete typed answer."""
    repaired=0
    if question_kinds is None:
        return repaired
    for row in rows:
        if row.method!='OCR' or len(row.tokens)<2 or not re.fullmatch(r'\d{1,2}',row.tokens[0].text):
            continue
        original=' '.join(t.text for t in row.tokens[1:])
        if re.fullmatch(r'NOT GIVEN|TRUE|FALSE|YES|NO|[A-Z]',original):continue
        kind=question_kinds.get(int(row.tokens[0].text))
        # The parsed question's printed instruction supplies the answer type.
        # Damaged words such as FALSF still need two own-ink reads; their
        # spelling must not prevent that verification from being attempted.
        enum=kind in ('TFNG','YNNG')
        letter=bool(re.fullmatch(r'[A-Z]',row.tokens[1].text))
        if not enum and not letter:continue
        if (enum and kind not in ('TFNG','YNNG')) or (not enum and kind not in ('SINGLE_CHOICE','MATCHING','LABEL_ASSIGNMENT')):
            continue
        prefix=row.tokens[0];height=row.y1-row.y0
        peers=[r for r in rows if r is not row and r.page==row.page and len(r.tokens)>=2
               and re.fullmatch(r'\d{1,2}',r.tokens[0].text)
               and abs(r.tokens[0].x0-prefix.x0)<.5*(r.y1-r.y0)
               and (_enum_span(r) is not None if enum else re.fullmatch(r'[A-Z]',r.tokens[1].text))]
        if len(peers)<3:continue
        measured=median(r.y1-r.y0 for r in peers)
        if not .6*measured<height<1.5*measured:continue
        answer_x=median(r.tokens[1].x0 for r in peers)
        ends=[_enum_span(r) if enum else r.tokens[1].x1 for r in peers]
        # Include the longest observed enum, including both NOT GIVEN words.
        # Choosing a shorter crop based on damaged text could truncate truth.
        right=(max(ends) if enum else median(ends))+.3*measured
        number_box=(max(0,prefix.x0-.4*measured),max(0,row.y0-.15*measured),
                    min(prefix.x1+.4*measured,answer_x-.5*measured),row.y1+.15*measured)
        answer_box=(answer_x-.2*measured,number_box[1],right,number_box[3])
        proven=[]
        for box,allow in ((number_box,'0123456789'),(answer_box,'ABCDEFGHIJKLMNOPQRSTUVWXYZ ')):
            agreed=[]
            for dpi in (300,600):
                agreed=[]
                for prep in ('P0','P2'):
                    result=cache.recognize(layer,row.page,box,dpi=dpi,pipeline=prep,allowlist=allow,boxes_pt=[box])
                    if not result or len(result.words)!=1 or result.words[0].conf<.85:break
                    text=result.words[0].text.strip()
                    text='NOT GIVEN' if re.sub(r'\s+','',text)=='NOTGIVEN' else text
                    agreed.append(text)
                if len(agreed)==2 and agreed[0]==agreed[1]:break
            if len(agreed)!=2 or agreed[0]!=agreed[1]:break
            proven.append(agreed[0])
        allowed_enum=r'NOT GIVEN|TRUE|FALSE' if kind=='TFNG' else r'NOT GIVEN|YES|NO'
        if len(proven)!=2 or proven[0]!=prefix.text or not (re.fullmatch(allowed_enum,proven[1]) if enum else re.fullmatch(r'[A-Z]',proven[1])):
            continue
        row.tokens=[prefix,Token(proven[1],answer_x,right)];repaired+=1
        log.add('ANSWER_KEY_OCR_REPAIRED',scope,'agreeing own ordinal and complete typed answer reads; adjacent debris excluded',
                pages=str(row.page),questions=prefix.text,severity='INFO')
    return repaired


def remove_score_header_rows(layer, rows, cache, log, scope):
    """A damaged score-table label is discarded only after its own label reads agree."""
    removed = []
    for row in rows:
        if row.method != 'OCR' or not re.search(r'\b(?:you|vou)\s+score\b',row.text,re.I):
            continue
        end = next((token.x1 for token in row.tokens if token.text.strip().lower()=='score'),None)
        if end is None:
            continue
        height = row.y1-row.y0
        box = (max(0,row.x0-.3*height),max(0,row.y0-.3*height),end,row.y1+.3*height)
        proven = False
        for crop in (box,(*box[:2],end-.4*height,box[3])):
            agreed = []
            for prep in ('P0','P2'):
                result = cache.recognize(layer,row.page,crop,dpi=150,pipeline=prep,boxes_pt=[crop])
                if not result or len(result.words) != 1 or result.words[0].conf < .85:
                    break
                agreed.append(re.sub(r'[^A-Z]','',result.words[0].text.upper()))
            if agreed == ['IFYOUSCORE','IFYOUSCORE']:
                proven = True
                break
        if proven:
            removed.append(row)
            log.add('ANSWER_KEY_OCR_REPAIRED',scope,'agreeing own score-table label reads; header removed',
                    pages=str(row.page),severity='INFO')
    rows[:] = [row for row in rows if row not in removed]
    return len(removed)


def recover_either_order_rows(layer, rows, cache, log, scope):
    """Recover paired keys from their own caption and two measured answer baselines."""
    repaired = 0
    for row in list(rows):
        if row.method != 'OCR' or not row.tokens or not re.search(
                r'IN\s*EITHER\s*ORDE[RK]', row.text, re.I):
            continue
        prefix = row.tokens[0]
        marker_at=next((i for i,t in enumerate(row.tokens) if re.match(r'^IN\b|^INEITHER',t.text,re.I)),None)
        if marker_at is not None and marker_at>1:
            parts=row.tokens[:marker_at]
            if not all(re.fullmatch(r'[\d&]+',t.text) for t in parts):
                continue
            prefix=Token(''.join(t.text for t in parts),parts[0].x0,parts[-1].x1)
        peers = [r for r in rows if r.page == row.page and r is not row and len(r.tokens) >= 2
                 and re.fullmatch(r'\d{1,2}', r.tokens[0].text.strip())
                 and 1 <= int(r.tokens[0].text) <= 40
                 and abs(r.tokens[0].x0-prefix.x0) < .45*(r.y1-r.y0)
                 and r.tokens[1].x0-r.tokens[0].x1 >= .8*(r.y1-r.y0)]
        if len(peers) < 3:
            continue
        height = median(r.y1-r.y0 for r in peers)
        ys = sorted({r.y0 for r in peers})
        gaps = [b-a for a,b in zip(ys,ys[1:]) if height < b-a < 2*height]
        if len(gaps) < 2:
            continue
        pitch = median(gaps)
        w, ph = layer.page_size(row.page)
        marker_x = row.tokens[marker_at].x0 if marker_at is not None else (row.tokens[1].x0 if len(row.tokens)>=2 else prefix.x0+4.4*height)
        if len(row.tokens) == 1 or not re.search(r'IN\s+EITHER\s+ORDER',row.text,re.I):
            marker = (max(0,marker_x-.25*height),max(0,row.y0-.25*height),
                      min(w,row.x1+.25*height),min(ph,row.y0+1.4*height))
            agreed = []
            for prep in ('P0','P2'):
                result = cache.recognize(layer,row.page,marker,dpi=300,pipeline=prep,
                                         allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZ',boxes_pt=[marker])
                if not result or len(result.words) != 1 or result.words[0].conf < .85:
                    break
                agreed.append(re.sub(r'\s+','',result.words[0].text).upper())
            if agreed != ['INEITHERORDER','INEITHERORDER']:
                continue
        if len(row.tokens) == 1:
            prefix = Token(prefix.text,prefix.x0,prefix.x0+3.5*height)
        caption = (max(0,prefix.x0-.25*height),max(0,row.y0-.25*height),
                   min(w,prefix.x1+.4*height),min(ph,row.y0+1.25*height))
        proven = None
        expanded = (*caption[:3],min(ph,row.y0+1.4*height))
        tighter = (*caption[:2],caption[2]-.25*height,min(ph,row.y0+1.3*height))
        for crop,dpi in ((caption,300),(caption,450),(expanded,300),(tighter,300)):
            reads = []
            for prep in ('P0','P2'):
                result = cache.recognize(layer,row.page,crop,dpi=dpi,pipeline=prep,
                                         allowlist='0123456789&',boxes_pt=[crop])
                if not result or len(result.words) != 1 or result.words[0].conf < .85:
                    break
                text = re.sub(r'\s+','',result.words[0].text)
                match = re.fullmatch(r'(\d{1,2})[&8](\d{1,2})',text)
                if not match or not (1 <= int(match[1]) < int(match[2]) <= 40
                                      and int(match[2]) == int(match[1])+1):
                    break
                reads.append(f'{int(match[1])}&{int(match[2])}')
            if len(reads) == 2 and reads[0] == reads[1]:
                proven = reads[0]
                break
        if proven is None:
            continue
        answer_x = median(r.tokens[1].x0 for r in peers)
        boxes = [(max(0,answer_x-.6*height),max(0,row.y0+k*pitch-.15*height),
                  min(w,answer_x+1.3*height),min(ph,row.y0+k*pitch+1.1*height)) for k in (1,2)]
        # A later printed numbered entry must never be consumed as this pair's answer.
        if any(row.y0 < p.y0 <= boxes[-1][3] for p in peers):
            continue
        letters = []
        for box in boxes:
            own = []
            for prep in ('P0','P2'):
                result = cache.recognize(layer,row.page,box,dpi=300,pipeline=prep,
                                         allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZ',boxes_pt=[box])
                if not result or len(result.words) != 1 or result.words[0].conf < .85:
                    break
                text = result.words[0].text.strip()
                if not re.fullmatch('[A-Z]',text):
                    break
                own.append(text)
            if len(own) != 2 or own[0] != own[1]:
                break
            letters.append(own[0])
        if len(letters) != 2:
            continue
        row.tokens = [Token(proven,prefix.x0,prefix.x1),
                      Token('IN EITHER ORDER',marker_x,row.x1)] + [
                          Token(letter,answer_x,answer_x+height) for letter in letters]
        rows[:] = [r for r in rows if r is row or not (
            r.page == row.page and boxes[0][1] <= r.y0 <= boxes[-1][3]
            and boxes[0][0] <= r.x0 and r.x1 <= boxes[-1][2]+1.2*height
            and (r.text.split() == letters or r.text in letters))]
        repaired += 1
        log.add('ANSWER_KEY_OCR_REPAIRED',scope,
                'paired own-caption digits and two agreeing own-letter baseline reads',
                questions=proven,pages=str(row.page),severity='INFO')
    return repaired


def normalize_chapter_headings(layer, rows):
    """Normalize whitespace/case in exact printed compound headings in the top band."""
    changed=0
    for row in rows:
        if row.method!='OCR' or row.y1>layer.page_size(row.page)[1]*.25:
            continue
        compact=re.sub(r'\s+','',row.text).upper()
        match=re.fullmatch(r'(READINGPASSAGE)([1-3])|(WRITINGTASK)([12])',compact)
        if not match:continue
        label='READING PASSAGE' if match[1] else 'WRITING TASK'
        number=match[2] or match[4]
        canonical=f'{label} {number}'
        if row.text!=canonical:
            row.tokens=[Token(canonical,row.x0,row.x1)]
            changed+=1
    return changed


def recover_key_skill_heading(layer, rows, cache):
    """Read the own heading band; a continued Reading page supplies no test identity."""
    badges = [r for r in rows if re.fullmatch(r'TEST\s*\d{1,2}', r.text, re.I)]
    if len(badges) > 1:
        return None
    badge = badges[0] if badges else None
    heads = [r for r in rows if (badge is None or r.y0 > badge.y1) and re.match(
        r'^(?:PART\s*1\b|SECTION\s*1\b|READING\s+PASSAGE\s*1\b)', r.text, re.I)]
    if not heads:
        return None
    first = min(heads, key=lambda r:r.y0)
    w, h = layer.page_size(first.page)
    if badge is None and (first.y0 > .25*h or not re.match(r'^READING\s+PASSAGE\s*1\b',first.text,re.I)):
        return None
    top = badge.y1 if badge is not None else max(0,first.y0-.07*h)
    if first.y0-top > .25*h:
        return None
    box = (0, top, w*.5, first.y0)
    reads=[]
    for prep in ('P0','P2'):
        result=cache.recognize(layer,first.page,box,dpi=200,pipeline=prep)
        words=[word for word in (result.words if result else [])
               if word.text.strip().upper() in ('LISTENING','READING') and word.conf >= .85]
        if len(words)!=1:
            return None
        reads.append(words[0])
    if reads[0].text.strip().upper()!=reads[1].text.strip().upper():
        return None
    if badge is None and reads[0].text.strip().upper() != 'READING':
        return None
    word=reads[0];x0,y0,x1,y1=word.bbox
    return Row(first.page,y0,y1,x0,x1,[Token(word.text.upper(),x0,x1)],'OCR',word.conf)


def own_glyph_text(layer, row, cache, x0, x1, allowlist):
    h = max(row.y1 - row.y0, 1)
    w, ph = layer.page_size(row.page)
    crops = [(.4, .6, 100)]
    if allowlist in ('0123456789', '0123456789&'):
        crops.insert(0, (.15, .15, 150))
        crops.append((.15, .15, 300))
    for xp, yp, dpi in crops:
        box = (max(0, x0 - xp * h), max(0, row.y0 - yp * h),
               min(w, x1 + xp * h), min(ph, row.y1 + yp * h))
        reads = []
        for prep in ('P0', 'P2'):
            result = cache.recognize(layer, row.page, box, dpi=dpi, pipeline=prep,
                                     allowlist=allowlist, boxes_pt=[box])
            if result is None or len(result.words) != 1 or result.words[0].conf < .85:
                break
            reads.append(re.sub(r'\s+', '', result.words[0].text).upper())
        if len(reads) == 2 and reads[0] == reads[1]:
            return reads[0]
    return None


def reread_key_ordinals(layer, rows, cache, log, scope):
    """Repair only isolated prefixes aligned with at least three printed key rows.

    No expected number, row position or missing sequence supplies the replacement.
    Fused answer/ordinal and either-order pairs stay with the existing parser.
    """
    repaired = 0
    for row in rows:
        if row.method != 'OCR' or len(row.tokens) < 2:
            continue
        token, value = row.tokens[:2]
        h = max(row.y1 - row.y0, 1)
        pair = bool(re.search(r'IN\s+EITHER\s+ORDER', row.text, re.I))
        if pair:
            peers = [r.y1-r.y0 for r in rows if r.page == row.page and len(r.tokens) >= 2
                     and re.fullmatch(r'\d{1,2}', r.tokens[0].text.strip())
                     and abs(r.tokens[0].x0-token.x0) < .45*h
                     and r.tokens[1].x0-r.tokens[0].x1 >= .8*(r.y1-r.y0)]
            if len(peers) >= 3 and h > 1.5 * median(peers):
                # OCR sometimes merges the pair header with its answer lines.
                # Reread only the first printed baseline using the same column's
                # measured line height; leave the answer tokens untouched.
                h = median(peers)
                row = replace(row, y1=row.y0+h)
        if ((not pair and len(token.text.strip()) > 2)
                or token.x1 - token.x0 > (5 if pair else 1.8) * h
                or value.x0 - token.x1 < .8 * h):
            continue
        anchors = [r for r in rows if r.page == row.page and r is not row and len(r.tokens) >= 2
                   and re.fullmatch(r'\d{1,2}', r.tokens[0].text.strip())
                   and 1 <= int(r.tokens[0].text) <= 40
                   and abs(r.tokens[0].x0 - token.x0) <= .45 * h
                   and r.tokens[1].x0 - r.tokens[0].x1 >= .8 * h]
        if len(anchors) < 3:
            continue
        text = own_glyph_text(layer, row, cache, token.x0, token.x1, '0123456789&' if pair else '0123456789')
        nums = re.fullmatch(r'(\d{1,2})&(\d{1,2})', text or '') if pair else None
        proven = (bool(nums) and 1 <= int(nums[1]) < int(nums[2]) <= 40
                  and int(nums[2]) == int(nums[1])+1) if pair else (
                  bool(text and re.fullmatch(r'\d{1,2}', text)) and 1 <= int(text) <= 40)
        if proven and text != token.text:
            # A low-resolution crop can collapse repeated digits (33 -> 3)
            # with high confidence. Every replacement needs two additional
            # high-resolution reads of the complete own prefix band.
            w,ph=layer.page_size(row.page)
            box=(max(0,token.x0-.25*h),max(0,row.y0-.3*h),
                 min(w,token.x1+.25*h),min(ph,row.y1+.3*h))
            confirmed=[]
            for prep in ('P0','P2'):
                result=cache.recognize(layer,row.page,box,dpi=300,pipeline=prep,
                    allowlist='0123456789&' if pair else '0123456789',boxes_pt=[box])
                if not result or len(result.words)!=1 or result.words[0].conf<.85:
                    break
                confirmed.append(re.sub(r'\s+','',result.words[0].text))
            if confirmed != [text,text]:
                continue
            token.text = text
            repaired += 1
            log.add('ANSWER_KEY_OCR_REPAIRED', scope,
                    'aligned isolated prefix; agreeing P0/P2 own-glyph reads',
                    questions=text, pages=str(row.page), severity='INFO')
    return repaired
