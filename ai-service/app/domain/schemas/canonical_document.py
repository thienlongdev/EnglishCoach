from __future__ import annotations
from typing import Any, Dict, List, Optional
SCHEMA_VERSION = "reading-document.v1"
def _bbox(x0: float, y0: float, x1: float, y1: float, page_width: float, page_height: float) -> Dict[str, float]:
    width=max(0.0,x1-x0); height=max(0.0,y1-y0)
    return {"x":round(x0,3),"y":round(y0,3),"width":round(width,3),"height":round(height,3),"xNorm":round(x0/page_width,6) if page_width else 0.0,"yNorm":round(y0/page_height,6) if page_height else 0.0,"widthNorm":round(width/page_width,6) if page_width else 0.0,"heightNorm":round(height/page_height,6) if page_height else 0.0}
def make_block(*,block_id:str,block_type:str,text:str,bbox:Dict[str,float],reading_order:int,confidence:Optional[float]=None,children:Optional[List[Dict[str,Any]]]=None)->Dict[str,Any]:
    return {"id":block_id,"type":block_type,"text":text,"bbox":bbox,"confidence":confidence,"readingOrder":reading_order,"children":children or []}
def make_page(page_number:int,width:float,height:float,blocks:List[Dict[str,Any]])->Dict[str,Any]:
    return {"pageNumber":page_number,"width":round(width,3),"height":round(height,3),"blocks":blocks}
def make_document(*,source_type:str,file_name:Optional[str],plain_text:str,pages:List[Dict[str,Any]],metadata:Optional[Dict[str,Any]]=None,processing:Optional[Dict[str,Any]]=None)->Dict[str,Any]:
    return {"schemaVersion":SCHEMA_VERSION,"sourceType":source_type,"source":{"fileName":file_name} if file_name else {},"plainText":plain_text,"pages":pages,"metadata":metadata or {},"processing":processing or {}}
