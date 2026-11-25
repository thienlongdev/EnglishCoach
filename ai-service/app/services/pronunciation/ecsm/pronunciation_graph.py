"""
ECSM-v1 / EC-PRISM Phase P4: Contextual Pronunciation Graph (G_VALID).
Builds a linguistically principled, auditable search graph of acceptable native
pronunciation variants (weak forms, flapping, linking, assimilation, reduction)
without admitting common learner error patterns into valid paths.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from app.services.pronunciation.articulatory_diagnosis import (
    CANONICAL_PHONE_PROFILES,
    CanonicalRealPhoneInventory,
)


class VariantProvenance(str, Enum):
    LEXICON_VARIANT = "LEXICON_VARIANT"
    G2P = "G2P"
    CONNECTED_SPEECH_RULE = "CONNECTED_SPEECH_RULE"
    ACCENT_VARIANT = "ACCENT_VARIANT"
    MANUAL_CURATED_RULE = "MANUAL_CURATED_RULE"


@dataclass(frozen=True)
class GraphNode:
    node_id: int
    phone: str
    word_index: int
    phone_index: int
    is_start: bool = False
    is_end: bool = False


@dataclass(frozen=True)
class GraphEdge:
    from_node: int
    to_node: int
    phone: str
    weight: float = 1.0
    provenance: VariantProvenance = VariantProvenance.LEXICON_VARIANT
    rule_name: Optional[str] = None


@dataclass
class PronunciationPath:
    phones: List[str]
    nodes: List[int]
    total_weight: float
    provenances: List[VariantProvenance]
    rule_names: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "phones": self.phones,
            "nodes": self.nodes,
            "totalWeight": float(self.total_weight),
            "provenances": [p.value for p in self.provenances],
            "ruleNames": self.rule_names,
        }


# Linguistically validated General American connected-speech rules
STANDARD_WEAK_FORMS: Dict[str, List[Tuple[List[str], str]]] = {
    # Word -> list of (phone_sequence, rule_name)
    "the": [
        (["ð", "ə"], "weak_article_schwa"),
        (["ð", "i"], "weak_article_prevocalic"),
        (["ð", "iː"], "citation_form"),
    ],
    "a": [
        (["ə"], "weak_article_schwa"),
        (["eɪ"], "citation_form"),
    ],
    "an": [
        (["ə", "n"], "weak_article_schwa"),
        (["æ", "n"], "citation_form"),
    ],
    "to": [
        (["t", "ə"], "weak_preposition_schwa"),
        (["t", "u"], "weak_preposition_prevocalic"),
        (["t", "uː"], "citation_form"),
    ],
    "for": [
        (["f", "ɚ"], "weak_preposition_rhotic_schwa"),
        (["f", "ɔːɹ"], "citation_form"),
    ],
    "of": [
        (["ə", "v"], "weak_preposition_schwa"),
        (["ɒ", "v"], "citation_form"),
        (["ʌ", "v"], "alternate_form"),
    ],
    "and": [
        (["ə", "n", "d"], "weak_conjunction_schwa"),
        (["ə", "n"], "weak_conjunction_elision"),
        (["æ", "n", "d"], "citation_form"),
    ],
    "can": [
        (["k", "ə", "n"], "weak_modal_schwa"),
        (["k", "æ", "n"], "citation_form"),
    ],
    "have": [
        (["h", "ə", "v"], "weak_auxiliary_schwa"),
        (["ə", "v"], "weak_auxiliary_h_elision"),
        (["h", "æ", "v"], "citation_form"),
    ],
    "was": [
        (["w", "ə", "z"], "weak_auxiliary_schwa"),
        (["w", "ɒ", "z"], "citation_form"),
        (["w", "ʌ", "z"], "alternate_form"),
    ],
    "that": [
        (["ð", "ə", "t"], "weak_conjunction_schwa"),
        (["ð", "æ", "t"], "citation_form"),
    ],
}


class ContextualPronunciationGraph:
    """
    Constructs an acyclic, bounded pronunciation graph G_VALID for an utterance.
    Enforces maximum expansion bounds (<= 32 paths) to prevent combinatorial explosion.
    """

    def __init__(
        self,
        words: Sequence[str],
        base_phoneme_sequences: Sequence[Sequence[str]],
        inventory: CanonicalRealPhoneInventory,
        max_paths: int = 32,
    ):
        self.words = [w.lower().strip() for w in words]
        self.base_sequences = [list(seq) for seq in base_phoneme_sequences]
        self.inventory = inventory
        self.max_paths = max_paths
        
        self.nodes: Dict[int, GraphNode] = {}
        self.edges: List[GraphEdge] = []
        self.adj: Dict[int, List[GraphEdge]] = {}
        self.paths: List[PronunciationPath] = []
        
        self._build_graph()

    def _build_graph(self) -> None:
        """
        Builds the forward pronunciation graph G_VALID from lexical bases and connected-speech rules.
        """
        # Node 0 is start
        self.nodes[0] = GraphNode(node_id=0, phone="<s>", word_index=-1, phone_index=-1, is_start=True)
        self.adj[0] = []
        
        current_layer_nodes = [0]
        node_counter = 1
        
        # Word-by-word expansion with bounded alternative variants
        for w_idx, (word, base_phones) in enumerate(zip(self.words, self.base_sequences)):
            word_variants: List[Tuple[List[str], VariantProvenance, str]] = []
            
            # 1. Base dictionary citation path
            word_variants.append((base_phones, VariantProvenance.LEXICON_VARIANT, "citation_lexicon"))
            
            # 2. Check weak-form alternatives
            if word in STANDARD_WEAK_FORMS:
                for variant_phones, rule_name in STANDARD_WEAK_FORMS[word]:
                    if variant_phones != base_phones:
                        word_variants.append((variant_phones, VariantProvenance.CONNECTED_SPEECH_RULE, rule_name))
                        
            # 3. Flapping rule: /t/ or /d/ between vowels -> [ɾ] / [r]
            if len(base_phones) >= 3:
                flapped = list(base_phones)
                has_flap = False
                for p_i in range(1, len(base_phones) - 1):
                    prev_p = base_phones[p_i - 1]
                    curr_p = base_phones[p_i]
                    next_p = base_phones[p_i + 1]
                    
                    prev_is_vow = CANONICAL_PHONE_PROFILES.get(prev_p, {}).get("isVowel", False)
                    next_is_vow = CANONICAL_PHONE_PROFILES.get(next_p, {}).get("isVowel", False)
                    if curr_p in ["t", "d"] and prev_is_vow and next_is_vow:
                        # Flapped variant
                        flapped[p_i] = "ɾ" if "ɾ" in self.inventory.phone2profile else "r"
                        has_flap = True
                        
                if has_flap and flapped != base_phones:
                    word_variants.append((flapped, VariantProvenance.CONNECTED_SPEECH_RULE, "intervocalic_flapping"))
                    
            # 4. Filter invalid phonemes outside inventory
            clean_variants: List[Tuple[List[str], VariantProvenance, str]] = []
            for v_phones, prov, r_name in word_variants:
                valid = [p for p in v_phones if p in self.inventory.phone2profile]
                if valid:
                    clean_variants.append((valid, prov, r_name))
                    
            # Bound variant count per word (max 4)
            clean_variants = clean_variants[:4]
            
            # Construct graph paths for this word
            next_layer_nodes: List[int] = []
            
            for v_phones, prov, r_name in clean_variants:
                # Create a chain of nodes for this variant
                chain_nodes = []
                for p_idx, phone in enumerate(v_phones):
                    nid = node_counter
                    node_counter += 1
                    node = GraphNode(node_id=nid, phone=phone, word_index=w_idx, phone_index=p_idx)
                    self.nodes[nid] = node
                    self.adj[nid] = []
                    chain_nodes.append(nid)
                    
                # Link internal chain
                for i in range(len(chain_nodes) - 1):
                    u = chain_nodes[i]
                    v = chain_nodes[i + 1]
                    e = GraphEdge(from_node=u, to_node=v, phone=self.nodes[v].phone, weight=1.0, provenance=prov, rule_name=r_name)
                    self.edges.append(e)
                    self.adj[u].append(e)
                    
                # Connect previous layer nodes to first node of this chain
                first_node = chain_nodes[0]
                for prev_node in current_layer_nodes:
                    e = GraphEdge(from_node=prev_node, to_node=first_node, phone=self.nodes[first_node].phone, weight=1.0, provenance=prov, rule_name=r_name)
                    self.edges.append(e)
                    self.adj[prev_node].append(e)
                    
                next_layer_nodes.append(chain_nodes[-1])
                
            current_layer_nodes = list(set(next_layer_nodes))
            
        # Terminal end node
        end_node_id = node_counter
        self.nodes[end_node_id] = GraphNode(node_id=end_node_id, phone="</s>", word_index=len(self.words), phone_index=0, is_end=True)
        self.adj[end_node_id] = []
        for prev_node in current_layer_nodes:
            e = GraphEdge(from_node=prev_node, to_node=end_node_id, phone="</s>", weight=1.0, provenance=VariantProvenance.LEXICON_VARIANT, rule_name="end")
            self.edges.append(e)
            self.adj[prev_node].append(e)
            
        # Extract all valid paths (bounded)
        self._extract_paths(0, [], [], [], 0.0)
        # Limit paths
        self.paths = self.paths[:self.max_paths]

    def _extract_paths(
        self,
        current_node: int,
        curr_phones: List[str],
        curr_nodes: List[int],
        curr_provs: List[VariantProvenance],
        curr_weight: float,
    ) -> None:
        if len(self.paths) >= self.max_paths:
            return
            
        if self.nodes[current_node].is_end:
            self.paths.append(PronunciationPath(
                phones=list(curr_phones),
                nodes=list(curr_nodes),
                total_weight=curr_weight,
                provenances=list(curr_provs),
                rule_names=[self.nodes[n].phone for n in curr_nodes],
            ))
            return
            
        for edge in self.adj.get(current_node, []):
            next_node = edge.to_node
            next_p = self.nodes[next_node].phone
            new_phones = curr_phones if self.nodes[next_node].is_end else curr_phones + [next_p]
            new_nodes = curr_nodes + [next_node]
            new_provs = curr_provs + [edge.provenance]
            self._extract_paths(next_node, new_phones, new_nodes, new_provs, curr_weight + edge.weight)

    def to_manifest(self) -> Dict[str, Any]:
        return {
            "numWords": len(self.words),
            "numNodes": len(self.nodes),
            "numEdges": len(self.edges),
            "numValidPaths": len(self.paths),
            "citationPath": self.paths[0].to_dict() if self.paths else {},
            "allPaths": [p.to_dict() for p in self.paths],
        }
