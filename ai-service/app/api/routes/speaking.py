from typing import List
from fastapi import APIRouter, UploadFile, File
from starlette.concurrency import run_in_threadpool
from app.workflows.speaking_workflow import (
    analyze_speaking,
    run_roleplay_turn_workflow,
    run_turn_feedback_workflow,
    run_generate_custom_scenario_workflow,
    run_quick_check_language_workflow,
)
from app.domain.schemas.speaking import (
    RoleplayTurnRequest,
    RoleplayTurnResponse,
    TurnFeedbackRequest,
    TurnFeedbackResponse,
    CustomScenarioGenerateRequest,
    CustomScenarioGenerateResponse,
    IPARequest,
    IPABatchRequest,
    SentenceIPAResponse,
    QuickCheckLanguageRequest,
    QuickCheckLanguageResponse,
)
from app.services.pronunciation.ipa_pipeline import get_ipa_pipeline

router = APIRouter(prefix="/speaking", tags=["speaking"])

@router.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    return await analyze_speaking(file)

@router.post("/roleplay/turn", response_model=RoleplayTurnResponse)
async def roleplay_turn(request: RoleplayTurnRequest):
    return await run_in_threadpool(run_roleplay_turn_workflow, request)

@router.post("/roleplay/feedback", response_model=TurnFeedbackResponse)
async def roleplay_feedback(request: TurnFeedbackRequest):
    return await run_in_threadpool(run_turn_feedback_workflow, request)

@router.post("/roleplay/generate-scenario", response_model=CustomScenarioGenerateResponse)
async def generate_custom_scenario(request: CustomScenarioGenerateRequest):
    return await run_in_threadpool(run_generate_custom_scenario_workflow, request)

@router.post("/ipa/process", response_model=SentenceIPAResponse)
async def process_ipa(request: IPARequest):
    pipeline = get_ipa_pipeline()
    accent = getattr(request, "accent", None)
    return await run_in_threadpool(pipeline.process_sentence, request.text, accent)

@router.post("/ipa/batch", response_model=List[SentenceIPAResponse])
async def process_ipa_batch(request: IPABatchRequest):
    pipeline = get_ipa_pipeline()
    accent = getattr(request, "accent", None)
    return await run_in_threadpool(lambda: [pipeline.process_sentence(s, accent) for s in request.sentences])

@router.post("/quick-check/language-check", response_model=QuickCheckLanguageResponse)
async def quick_check_language_check(request: QuickCheckLanguageRequest):
    return await run_in_threadpool(run_quick_check_language_workflow, request)

