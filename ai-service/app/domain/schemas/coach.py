from pydantic import BaseModel
from typing import List

class CoachRequest(BaseModel):
    user_id: str
    current_level: str
    target: str
    daily_minutes: int
    weaknesses: List[str] = []

class CoachResponse(BaseModel):
    summary: str
    weekly_plan: List[str]
    recommended_features: List[str]
