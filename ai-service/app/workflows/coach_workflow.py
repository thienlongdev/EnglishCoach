from app.domain.schemas.coach import CoachRequest, CoachResponse

import os
from langchain_openai import ChatOpenAI

def run_coach_workflow(request: CoachRequest) -> CoachResponse:
    llm = ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), temperature=0.2)
    prompt = f"""
    You are an expert English Language Coach. Create a personalized learning plan.
    Current Level: {request.current_level}
    Target Goal: {request.target}
    Daily Commitment: {request.daily_minutes} minutes

    Provide a concise summary, a list of weekly focus areas, and recommended features (e.g. Vocabulary, Speaking).
    Return only valid JSON matching the schema.
    """
    
    structured_llm = llm.with_structured_output(CoachResponse)
    return structured_llm.invoke(prompt)
