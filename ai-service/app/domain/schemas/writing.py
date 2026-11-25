from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field

class IssueKind(str, Enum):
    ERROR = "ERROR"
    IMPROVEMENT = "IMPROVEMENT"
    UNCERTAIN = "UNCERTAIN"

class IssueSeverity(str, Enum):
    CRITICAL = "CRITICAL"
    MAJOR = "MAJOR"
    MINOR = "MINOR"
    SUGGESTION = "SUGGESTION"

class DimensionStatus(str, Enum):
    CORRECT = "CORRECT"
    NEEDS_WORK = "NEEDS_WORK"
    UNCERTAIN = "UNCERTAIN"
    UNAVAILABLE = "UNAVAILABLE"

class PracticeMode(str, Enum):
    COMBINE = "COMBINE"
    REPAIR = "REPAIR"
    EXPAND = "EXPAND"
    REWRITE_NATURALLY = "REWRITE_NATURALLY"
    PARAPHRASE = "PARAPHRASE"
    CHANGE_REGISTER = "CHANGE_REGISTER"
    IMPROVE_COHESION = "IMPROVE_COHESION"

class FeedbackIssueSchema(BaseModel):
    kind: IssueKind = Field(..., description="Classification of the finding")
    severity: IssueSeverity = Field(..., description="Severity level")
    category: str = Field(..., description="Grammar, Vocabulary, Naturalness, Cohesion, or Punctuation")
    pattern_code: Optional[str] = Field(None, description="Canonical error pattern code from approved taxonomy")
    title: str = Field(..., description="Concise issue title")
    explanation: str = Field(..., description="Clear explanation for the learner")
    source_quote: str = Field(..., description="Exact quoted substring from the learner input")
    start_offset: int = Field(..., description="UTF-16 start character offset in learner text")
    end_offset: int = Field(..., description="UTF-16 end character offset in learner text")
    replacement: Optional[str] = Field(None, description="Recommended replacement text if applicable")
    teaching_rule: Optional[str] = Field(None, description="General English rule to remember")
    suggested_practice_mode: Optional[PracticeMode] = Field(None, description="Suggested practice exercise mode")

class DimensionVerdictSchema(BaseModel):
    dimension: str = Field(..., description="Dimension name: Grammar, Naturalness, Vocabulary, Cohesion, Task")
    status: DimensionStatus = Field(..., description="Verdict status")
    summary: str = Field(..., description="Summary statement for the dimension")
    score: Optional[int] = Field(None, ge=0, le=100, description="Nullable score 0-100; null if unavailable")

# Sentence Analysis Schemas
class SentenceAnalysisRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Learner sentence text")
    target_register: Optional[str] = Field("formal", description="formal, neutral, or casual")
    context_note: Optional[str] = Field(None, max_length=500, description="Optional situational context")
    model: Optional[str] = Field(None, description="Optional isolated primary model override for Sentence Lab")
    fallback_model: Optional[str] = Field(None, description="Optional fallback model override for Sentence Lab on provider failure")

class SentenceAnalysisResponse(BaseModel):
    grammatically_correct: Optional[bool] = Field(None, description="True if analyzed and confirmed correct, False if confirmed incorrect, None if unavailable or inconclusive")
    analysis_status: Optional[str] = Field("COMPLETED", description="COMPLETED, ANALYSIS_UNAVAILABLE, or INCONCLUSIVE")
    dimension_verdicts: List[DimensionVerdictSchema] = Field(default_factory=list)
    issues: List[FeedbackIssueSchema] = Field(default_factory=list)
    suggested_improvement: Optional[str] = Field(None, description="Optional natural polish if grammatically correct")
    explanation: Optional[str] = Field(None, description="Overall commentary")
    model_used: Optional[str] = Field(None, description="Model identifier that produced this analysis")
    result_source: Optional[str] = Field(None, description="PRIMARY, FALLBACK, or CACHE")

# Document Analysis Schemas
class DocumentAnalysisRequest(BaseModel):
    task_prompt: str = Field(..., description="Writing prompt and requirements")
    task_guidance: Optional[str] = Field(None, description="Word count and register guidance")
    task_category: str = Field("Everyday", description="Everyday, Academic, Work, Creative")
    learner_plan: Optional[str] = Field(None, description="Learner plan or brainstormed ideas")
    draft_content: str = Field(..., min_length=1, max_length=25000, description="Submitted essay draft")
    draft_ordinal: int = Field(1, ge=1, description="Draft version number")
    model: Optional[str] = Field(None, description="Model override for document evaluation")
    fallback_model: Optional[str] = Field(None, description="Fallback model override")

class DocumentAnalysisResponse(BaseModel):
    overall_score: Optional[int] = Field(None, ge=0, le=100, description="Nullable overall rubric score")
    dimension_verdicts: List[DimensionVerdictSchema] = Field(default_factory=list)
    issues: List[FeedbackIssueSchema] = Field(default_factory=list)
    strengths: List[str] = Field(default_factory=list, description="Specific things the learner did well")
    prioritized_issue_indices: List[int] = Field(default_factory=list, description="Indices of 3-4 highest priority issues")
    summary: str = Field(..., description="Constructive, encouraging coach summary")

# Plan Organization Schemas
class PlanOrganizationRequest(BaseModel):
    task_prompt: str = Field(..., description="Task instructions")
    learner_ideas: List[str] = Field(..., description="Raw learner-provided idea strings")

class PlanSectionSchema(BaseModel):
    section_title: str = Field(..., description="e.g. Introduction, Argument 1, Argument 2, Conclusion")
    points: List[str] = Field(..., description="Organized learner points (only from supplied ideas)")

class PlanOrganizationResponse(BaseModel):
    organized_sections: List[PlanSectionSchema] = Field(default_factory=list)
    suggestions: List[str] = Field(default_factory=list, description="Helpful prompts for missing aspects")

# Practice Evaluation Schemas
class PracticeEvaluationRequest(BaseModel):
    mode: PracticeMode = Field(..., description="One of the 7 practice modes")
    prompt: str = Field(..., description="Exercise instructions")
    original_context: Optional[str] = Field(None, description="Base text being manipulated")
    target_pattern_code: Optional[str] = Field(None, description="Target error pattern code if any")
    constraints: List[str] = Field(default_factory=list, description="Required grammatical constraints")
    learner_answer: str = Field(..., min_length=1, max_length=1000, description="Learner free response")
    attempt_number: int = Field(1, ge=1, description="Attempt number in current episode")

class PracticeEvaluationResponse(BaseModel):
    is_success: bool = Field(..., description="True if answer correctly satisfies prompt and constraints")
    feedback: str = Field(..., description="Targeted feedback on the attempt")
    alternative_valid_answers: List[str] = Field(default_factory=list)
    hint_if_needed: Optional[str] = Field(None, description="Progressive hint if failed and eligible")

# P1 Schemas: Adaptive Task Generation
class AdaptiveTaskGenerationRequest(BaseModel):
    learner_cefr_level: str = Field("B1", description="A1, A2, B1, B2, C1, C2")
    focus_pattern_codes: List[str] = Field(default_factory=list, description="Target error patterns to elicit and practice")
    preferred_category: Optional[str] = Field("Everyday", description="Everyday, Work, Academic, Creative")
    preferred_register: Optional[str] = Field("neutral", description="formal, neutral, casual")

class AdaptiveTaskGenerationResponse(BaseModel):
    title: str = Field(..., description="Task title")
    prompt: str = Field(..., description="Task prompt")
    guidance: str = Field(..., description="Guidance notes")
    audience: str = Field(..., description="Intended audience")
    target_register: str = Field(..., description="Target register")
    target_word_count_min: int = Field(100, ge=30)
    target_word_count_max: int = Field(200, le=2000)
    requirements: List[str] = Field(default_factory=list, description="Specific pedagogical requirements")
    elicited_patterns: List[str] = Field(default_factory=list, description="Patterns specifically tested")

# P1 Schemas: Socratic Planning Guidance
class SocraticSuggestionItem(BaseModel):
    id: str = Field(..., description="Unique suggestion ID")
    operation: str = Field("ADD", description="Operation type: ADD, MODIFY, COUNTERARGUMENT, EVIDENCE, STRUCTURAL, EXPAND")
    section: str = Field("counterargument", description="Target section: thesis, counterargument, main_argument, synthesis, evidence, conclusion")
    content: str = Field(..., description="Structured suggestion statement or argument outline")
    reasoning: Optional[str] = Field(None, description="Why this supports the learner's essay")

class SocraticPlanRequest(BaseModel):
    task_prompt: str = Field(..., description="Task requirements")
    current_plan: Optional[str] = Field(None, description="Draft plan or ideas so far")
    learner_question: Optional[str] = Field(None, description="Learner specific doubt or block")

class SocraticPlanResponse(BaseModel):
    probing_questions: List[str] = Field(..., description="2-3 targeted Socratic questions to stimulate learner thinking")
    structural_prompts: List[str] = Field(default_factory=list, description="Organizational nudges for section transitions")
    encouragement: str = Field(..., description="Supportive coaching guidance")
    suggested_items: List[SocraticSuggestionItem] = Field(default_factory=list, description="Structured outline suggestions matching learner intent")

# P1 Schemas: Model Answer Comparison
class ModelAnswerComparisonRequest(BaseModel):
    task_prompt: str = Field(..., description="Task instructions")
    learner_draft: Optional[str] = Field("", description="Learner current draft (optional for pure exemplar)")
    target_register: Optional[str] = Field("formal", description="Target register")
    learner_level: Optional[str] = Field("B1", description="Learner CEFR level for reachable exemplar calibration")

class ModelAnswerComparisonResponse(BaseModel):
    exemplar_model_answer: str = Field(..., description="Exemplar native-standard model answer for the same prompt")
    calibrated_level: Optional[str] = Field("B1+/B2", description="Calibrated pedagogical CEFR band of the exemplar")
    structural_observations: List[str] = Field(default_factory=list, description="Comparison of rhetorical structure and transitions")
    lexical_alternatives: List[str] = Field(default_factory=list, description="Advanced vocabulary or collocation opportunities")
    coaching_summary: str = Field(..., description="Constructive encouragement highlighting learner strengths and expansion paths")

# Translation Practice Grading Schemas
class TranslationIssueItem(BaseModel):
    offset_start: int = Field(0, description="0-based start character offset in learner submitted text")
    offset_end: int = Field(0, description="0-based end character offset in learner submitted text")
    flagged_text: str = Field("", description="Exact substring in learner submitted text")
    category: str = Field("GRAMMAR", description="Issue category: GRAMMAR, MEANING, VOCABULARY, SPELLING, PUNCTUATION")
    message: str = Field(..., description="Helpful explanation in Vietnamese")
    suggestion: Optional[str] = Field(None, description="Correction or alternative phrase")

class TranslationGradeRequest(BaseModel):
    source_vi: str = Field(..., description="Vietnamese source text")
    reference_en: str = Field(..., description="Server-side reference translation")
    submitted_en: str = Field(..., description="Learner submitted English text")
    topic_code: Optional[str] = Field("GENERAL", description="Topic code")
    difficulty_bucket: Optional[str] = Field("CORE", description="Difficulty bucket")
    target_chunks: Optional[List[dict]] = Field(default_factory=list, description="Target chunks/collocations")
    model: Optional[str] = Field(None, description="Primary model override")
    fallback_model: Optional[str] = Field(None, description="Fallback model override")

class TranslationGradeResponse(BaseModel):
    meaning_verdict: str = Field("ACCURATE", description="ACCURATE, PARTIAL, INACCURATE, UNCERTAIN")
    grammar_verdict: str = Field("ACCURATE", description="ACCURATE, MINOR_ISSUES, INCORRECT, UNCERTAIN")
    naturalness_verdict: str = Field("NATURAL", description="NATURAL, ACCEPTABLE, AWKWARD, UNCERTAIN")
    overall_status: str = Field("ACCEPTED", description="ACCEPTED, NEEDS_REVISION, INCORRECT, UNCERTAIN")
    accepted: Optional[bool] = Field(True, description="True if acceptable translation, False if unacceptable, None if uncertain")
    headline_summary: str = Field(..., description="Concise feedback in Vietnamese")
    natural_suggestion: Optional[str] = Field(None, description="Recommended natural alternative translation")
    issues: List[TranslationIssueItem] = Field(default_factory=list, description="Specific identified issues")


class TranslationParagraphIssueItem(BaseModel):
    offset_start: int = Field(0, description="Start character offset in submitted English text")
    span_start: Optional[int] = Field(None, description="Alias for offset_start")
    offset_end: int = Field(0, description="End character offset in submitted English text")
    span_end: Optional[int] = Field(None, description="Alias for offset_end")
    flagged_text: str = Field("", description="Exact substring in learner submitted text")
    learner_span: Optional[str] = Field(None, description="Alias for flagged_text")
    category: str = Field("GRAMMAR", description="MEANING, GRAMMAR, NATURALNESS, VOCABULARY, COHESION")
    dimension: Optional[str] = Field(None, description="Alias for category")
    severity: str = Field("ERROR", description="ERROR, IMPROVEMENT, STYLE")
    issue_type: Optional[str] = Field(None, description="Alias for severity")
    message: str = Field(..., description="Helpful explanation in Vietnamese")
    suggestion: Optional[str] = Field(None, description="Correction or alternative phrase")


class TranslationParagraphGradeRequest(BaseModel):
    source_vi: str = Field(..., description="Vietnamese source paragraph")
    reference_en: str = Field(..., description="Server-side reference translation")
    submitted_en: str = Field(..., description="Learner submitted English paragraph")
    genre: Optional[str] = Field("GENERAL", description="Passage genre")
    topic: Optional[str] = Field("GENERAL", description="Passage topic")
    model: Optional[str] = Field(None, description="Primary model override")
    fallback_model: Optional[str] = Field(None, description="Fallback model override")


class TranslationParagraphGradeResponse(BaseModel):
    meaning_verdict: str = Field("ACCURATE", description="ACCURATE, MINOR_ISSUES, INACCURATE, UNCERTAIN")
    meaning_score: Optional[int] = Field(None, description="Optional 0-100 score")
    grammar_verdict: str = Field("ACCURATE", description="ACCURATE, MINOR_ISSUES, INCORRECT, UNCERTAIN")
    grammar_score: Optional[int] = Field(None, description="Optional 0-100 score")
    naturalness_verdict: str = Field("NATURAL", description="NATURAL, ACCEPTABLE, UNNATURAL, UNCERTAIN")
    naturalness_score: Optional[int] = Field(None, description="Optional 0-100 score")
    vocabulary_verdict: str = Field("ACCURATE", description="ACCURATE, ACCEPTABLE, INACCURATE, UNCERTAIN")
    vocabulary_score: Optional[int] = Field(None, description="Optional 0-100 score")
    cohesion_verdict: str = Field("COHESIVE", description="COHESIVE, ACCEPTABLE, DISJOINTED, UNCERTAIN")
    cohesion_score: Optional[int] = Field(None, description="Optional 0-100 score")
    overall_status: str = Field("ACCEPTED", description="ACCEPTED, NEEDS_REVISION, UNCERTAIN")
    evaluation_status: Optional[str] = Field(None, description="Alias for overall_status")
    accepted: Optional[bool] = Field(True, description="True if acceptable translation, False if needs revision, None if uncertain")
    headline_summary: str = Field(..., description="Concise feedback in Vietnamese")
    overall_summary: Optional[str] = Field(None, description="Alias for headline_summary")
    natural_suggestion: Optional[str] = Field(None, description="Recommended natural alternative translation")
    natural_alternative: Optional[str] = Field(None, description="Alias for natural_suggestion")
    issues: List[TranslationParagraphIssueItem] = Field(default_factory=list, description="Specific identified issues")
    suggested_correction: Optional[str] = Field(None, description="Suggested correction")
    model_id: Optional[str] = Field(None, description="Model identifier")
    generation_count: Optional[int] = Field(1, description="Number of generations")
    latency_ms: Optional[int] = Field(None, description="Latency in milliseconds")


