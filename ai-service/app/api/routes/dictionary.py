from fastapi import APIRouter
from app.domain.schemas.dictionary import DictionaryResponse
from app.services.dictionary_service import lookup_word
router = APIRouter(prefix="/dictionary", tags=["dictionary"])
@router.get("/{word}", response_model=DictionaryResponse)
def dictionary(word: str) -> DictionaryResponse:
    return lookup_word(word)
