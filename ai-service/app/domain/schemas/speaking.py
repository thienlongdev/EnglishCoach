from typing import List, Optional
from pydantic import BaseModel, Field

class DialogueTurnItem(BaseModel):
    speaker: str = Field(..., description="'LEARNER' or 'ASSISTANT'")
    text: str = Field(..., description="Spoken turn transcript or response")

class RoleplayTurnRequest(BaseModel):
    scenario_title: str
    cefr_level: Optional[str] = "B1"
    ai_role: str
    learner_role: str
    learner_goal: Optional[str] = None
    target_vocabulary: List[str] = []
    target_grammar: List[str] = []
    learner_transcript: str
    history: List[DialogueTurnItem] = []

class TurnCorrectionItem(BaseModel):
    type: str = Field(..., description="'GRAMMAR', 'VOCABULARY', or 'NATURALNESS'")
    original: str = Field(..., description="Exact original phrase from learner's transcript")
    suggestion: str = Field(..., description="Better alternative phrasing")
    explanation: str = Field(..., description="Short explanation of why the suggestion improves fluency")
    priority: Optional[str] = Field(default="MEDIUM", description="'HIGH', 'MEDIUM', or 'LOW'")

class RoleplayTurnResponse(BaseModel):
    assistant_text: str = Field(..., description="In-character natural spoken dialogue response from the AI role partner")
    target_vocabulary_detected: List[str] = Field(default_factory=list, description="Target vocabulary words detected in learner's transcript")
    task_completed: bool = Field(default=False, description="Whether the scenario mission goal has clearly and fully been achieved based on conversation history")
    corrections: List[TurnCorrectionItem] = Field(default_factory=list, description="Maximum 1-2 high-priority corrections in grammar, vocabulary, or naturalness based on learner's utterance")
    positive_feedback: Optional[str] = Field(default=None, description="Positive reinforcement for good expression or target vocabulary usage")
    summary: Optional[str] = Field(default=None, description="Brief 1-sentence assessment of conversational effectiveness and fluency")
    is_mocked: bool = Field(default=False, description="Whether the dialogue response was generated via offline mock/fallback")

class CustomScenarioGenerateRequest(BaseModel):
    topic: str
    cefr_level: Optional[str] = "B1"
    context: Optional[str] = None
    learner_role: str
    ai_role: str
    mission: str
    target_vocabulary: Optional[List[str]] = []
    target_turns: Optional[int] = None
    estimated_duration: Optional[str] = None
    estimated_minutes: Optional[int] = None

class CustomScenarioGenerateResponse(BaseModel):
    title: str = Field(..., description="Engaging, clear title for the scenario")
    description: str = Field(..., description="Detailed context and setting for the role-play")
    category: str = Field(default="DAILY_LIFE", description="Category: TRAVEL, DAILY_LIFE, BUSINESS, WORK, ACADEMIC, CASUAL")
    cefr_level: str = Field(default="B1", description="CEFR difficulty: A1, A2, B1, B2, C1, C2")
    learner_role: str = Field(..., description="Role assigned to the learner")
    ai_role: str = Field(..., description="Role played by the AI partner")
    learner_goal: str = Field(..., description="Actionable mission goal for the learner to achieve")
    target_vocabulary: List[str] = Field(default_factory=list, description="6-8 relevant vocabulary words/phrases")
    target_grammar: List[str] = Field(default_factory=list, description="2-3 useful sentence patterns or grammar structures")
    initial_ai_message: str = Field(..., description="Natural spoken opening line from the AI partner to start the dialogue")
    success_criteria: List[str] = Field(default_factory=list, description="2-3 concrete bullet points to succeed in the scenario")
    optional_hints: List[str] = Field(default_factory=list, description="1-2 helpful conversational tips")
    estimated_minutes: int = Field(default=5, description="Estimated duration in minutes")
    is_mocked: bool = Field(default=False, description="Whether scenario was generated via offline fallback")

class TurnFeedbackRequest(BaseModel):
    learner_transcript: str
    scenario_title: Optional[str] = None
    cefr_level: Optional[str] = "B1"
    ai_role: Optional[str] = None
    learner_role: Optional[str] = None
    learner_goal: Optional[str] = None
    target_vocabulary: List[str] = []
    history: List[DialogueTurnItem] = []

class TurnFeedbackResponse(BaseModel):
    corrections: List[TurnCorrectionItem] = Field(default_factory=list, description="Maximum 1-2 high-priority corrections")
    positive_feedback: Optional[str] = Field(default=None, description="Positive reinforcement for good expression or target vocabulary usage")
    summary: Optional[str] = Field(default=None, description="Brief 1-sentence assessment of fluency")
    is_mocked: bool = Field(default=False, description="Whether feedback was generated via offline fallback")

class WordIPAMetadata(BaseModel):
    surface: str
    normalized: str
    ipa: str
    source: str = "CMUDICT"
    alternatives: List[str] = Field(default_factory=list)
    prefix: Optional[str] = ""
    suffix: Optional[str] = ""

class SentenceIPAResponse(BaseModel):
    text: str
    sentenceIpa: str
    words: List[WordIPAMetadata] = Field(default_factory=list)

class IPARequest(BaseModel):
    text: str
    accent: Optional[str] = None

class IPABatchRequest(BaseModel):
    sentences: List[str]
    accent: Optional[str] = None

class QuickCheckLanguageCorrection(BaseModel):
    type: str = Field(..., description="'GRAMMAR', 'NATURALNESS', 'WORD_CHOICE', or 'COLLOCATION'")
    original: str = Field(..., description="Exact original substring from transcript")
    suggestion: str = Field(..., description="Better English phrasing")
    explanation_vi: str = Field(..., description="Clear explanation in Vietnamese")

class QuickCheckLanguageRequest(BaseModel):
    transcript: str = Field(..., description="The learner's recognized or corrected English sentence")

class QuickCheckLanguageResponse(BaseModel):
    status: str = Field(default="CORRECT", description="'CORRECT' or 'NEEDS_IMPROVEMENT'")
    positive_feedback: Optional[str] = Field(default=None, description="Encouraging feedback in Vietnamese")
    corrections: List[QuickCheckLanguageCorrection] = Field(default_factory=list, description="0 to 3 high-confidence corrections")
    natural_version: Optional[str] = Field(default=None, description="A natural native-like alternative phrasing in English, if meaningful")
    meaning_note_vi: Optional[str] = Field(default=None, description="Brief note on meaning or nuance in Vietnamese")
    is_mocked: bool = Field(default=False, description="Whether feedback was generated via fallback")

