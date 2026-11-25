from pydantic import BaseModel
from typing import List
class DictionaryResponse(BaseModel):
    word: str
    ipa: str
    cefr: str
    meanings: List[str]
    examples: List[str]
    synonyms: List[str]
    collocations: List[str]
