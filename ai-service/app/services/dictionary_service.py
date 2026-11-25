from app.domain.schemas.dictionary import DictionaryResponse

import os
from langchain_openai import ChatOpenAI

def lookup_word(word: str) -> DictionaryResponse:
    llm = ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), temperature=0)
    
    prompt = f"""
    You are an expert English dictionary. Provide the definition for the word: "{word}".
    Return only valid JSON matching the schema.
    """
    
    structured_llm = llm.with_structured_output(DictionaryResponse)
    result = structured_llm.invoke(prompt)
    return result
