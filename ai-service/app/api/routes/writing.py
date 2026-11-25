from fastapi import APIRouter, HTTPException, status
from app.domain.schemas.writing import (
    SentenceAnalysisRequest,
    SentenceAnalysisResponse,
    PlanOrganizationRequest,
    PlanOrganizationResponse,
    DocumentAnalysisRequest,
    DocumentAnalysisResponse,
    AdaptiveTaskGenerationRequest,
    AdaptiveTaskGenerationResponse,
    SocraticPlanRequest,
    SocraticPlanResponse,
    ModelAnswerComparisonRequest,
    ModelAnswerComparisonResponse,
    TranslationGradeRequest,
    TranslationGradeResponse,
    TranslationParagraphGradeRequest,
    TranslationParagraphGradeResponse,
)
from app.workflows.writing_workflow import (
    analyze_sentence,
    organize_plan,
    analyze_document,
    generate_adaptive_task,
    generate_socratic_guidance,
    compare_model_answer,
)
from app.workflows.translation_workflow import grade_translation
from app.workflows.translation_paragraph_workflow import grade_paragraph_translation

router = APIRouter()

@router.post(
    "/sentence-check",
    response_model=SentenceAnalysisResponse,
    status_code=status.HTTP_200_OK,
    summary="Analyze a sentence for grammar, naturalness, and vocabulary",
)
async def check_sentence_endpoint(request: SentenceAnalysisRequest) -> SentenceAnalysisResponse:
    try:
        return analyze_sentence(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Sentence analysis failed: {str(exc)}"
        )

@router.post(
    "/plan-organize",
    response_model=PlanOrganizationResponse,
    status_code=status.HTTP_200_OK,
    summary="Organize brainstormed ideas into structured essay sections",
)
async def organize_plan_endpoint(request: PlanOrganizationRequest) -> PlanOrganizationResponse:
    try:
        return organize_plan(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Plan organization failed: {str(exc)}"
        )

@router.post(
    "/document-assessment",
    response_model=DocumentAnalysisResponse,
    status_code=status.HTTP_200_OK,
    summary="Assess full essay draft with dimension rubrics and prioritized feedback",
)
def assess_document_endpoint(request: DocumentAnalysisRequest) -> DocumentAnalysisResponse:
    try:
        return analyze_document(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Document assessment failed: {str(exc)}"
        )

@router.post(
    "/task-generate",
    response_model=AdaptiveTaskGenerationResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate adaptive writing task tailored to CEFR level, target register, and focus error patterns",
)
async def generate_task_endpoint(request: AdaptiveTaskGenerationRequest) -> AdaptiveTaskGenerationResponse:
    try:
        return generate_adaptive_task(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Adaptive task generation failed: {str(exc)}"
        )

@router.post(
    "/socratic-plan",
    response_model=SocraticPlanResponse,
    status_code=status.HTTP_200_OK,
    summary="Provide Socratic planning guidance with probing questions and structural prompts",
)
async def socratic_plan_endpoint(request: SocraticPlanRequest) -> SocraticPlanResponse:
    try:
        return generate_socratic_guidance(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Socratic planning guidance failed: {str(exc)}"
        )

@router.post(
    "/compare-model",
    response_model=ModelAnswerComparisonResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate and compare draft against an exemplar model answer with rhetorical and lexical observations",
)
def compare_model_endpoint(request: ModelAnswerComparisonRequest) -> ModelAnswerComparisonResponse:
    try:
        return compare_model_answer(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model answer comparison failed: {str(exc)}"
        )

@router.post(
    "/translation-grade",
    response_model=TranslationGradeResponse,
    status_code=status.HTTP_200_OK,
    summary="Grade learner Vietnamese to English translation with single-pass semantic, grammatical and naturalness evaluation",
)
async def grade_translation_endpoint(request: TranslationGradeRequest) -> TranslationGradeResponse:
    try:
        return grade_translation(request)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Translation grading failed: {str(exc)}"
        )

@router.post(
    "/translation-paragraph-grade",
    response_model=TranslationParagraphGradeResponse,
    status_code=status.HTTP_200_OK,
    summary="Grade learner whole-paragraph translation across meaning, grammar, naturalness, vocabulary, and cohesion",
)
async def grade_paragraph_translation_endpoint(request: TranslationParagraphGradeRequest) -> TranslationParagraphGradeResponse:
    try:
        return grade_paragraph_translation(request)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Paragraph translation grading failed: {str(exc)}"
        )
