"""
Scoring utilities for rank and filter papers tool.
"""

import json
import math
import os
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set, Tuple

from .types import PaperInput, UserProfile
from runtime.service_config import build_async_openai_client

# Weight tables for different purposes
WEIGHTS: Dict[str, Dict[str, float]] = {
    "general": {
        "semantic": 0.30,
        "must_kw": 0.10,
        "author": 0.15,
        "institution": 0.10,
        "recency": 0.20,
        "practicality": 0.15
    },
    "literature_review": {
        "semantic": 0.25,
        "must_kw": 0.10,
        "author": 0.15,
        "institution": 0.10,
        "recency": 0.15,  # Less emphasis on recency for literature review
        "practicality": 0.25
    },
    "implementation": {
        "semantic": 0.25,
        "must_kw": 0.10,
        "author": 0.10,
        "institution": 0.10,
        "recency": 0.20,
        "practicality": 0.25  # Higher emphasis on practicality (code availability)
    },
    "idea_generation": {
        "semantic": 0.30,
        "must_kw": 0.10,
        "author": 0.15,
        "institution": 0.10,
        "recency": 0.30,  # Higher emphasis on recency for new ideas
        "practicality": 0.05
    }
}

# Try to import OpenAI for LLM verification
try:
    from openai import OpenAI, AsyncOpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False
    OpenAI = None  # type: ignore
    AsyncOpenAI = None  # type: ignore

# Try to import sentence-transformers
try:
    from sentence_transformers import SentenceTransformer
    HAS_SENTENCE_TRANSFORMERS = True
except ImportError:
    HAS_SENTENCE_TRANSFORMERS = False
    SentenceTransformer = None  # type: ignore

# Try to import sklearn for cosine similarity
try:
    from sklearn.metrics.pairwise import cosine_similarity
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False
    cosine_similarity = None  # type: ignore

# Try to import numpy for weighted average embeddings
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    np = None  # type: ignore

# Interest group weights for weighted average embedding
INTEREST_WEIGHTS: Dict[str, float] = {
    "primary": 1.0,
    "secondary": 0.7,
    "exploratory": 0.4
}

# Module-level model cache for singleton pattern
_embedding_model_cache = None


def _get_embedding_model():
    """
    Get or create the embedding model (singleton pattern).
    
    Returns the cached SentenceTransformer model, loading it only once.
    Returns None if sentence-transformers is not available or loading fails.
    """
    global _embedding_model_cache
    if _embedding_model_cache is None and HAS_SENTENCE_TRANSFORMERS:
        try:
            _embedding_model_cache = SentenceTransformer('all-MiniLM-L6-v2')
        except Exception:
            _embedding_model_cache = None
    return _embedding_model_cache


def _calculate_embedding_scores(
    papers: List[PaperInput],
    profile: UserProfile
) -> Dict[str, float]:
    """
    Calculate embedding-based relevance scores for papers.
    
    Uses sentence-transformers to compute semantic similarity between
    user interests and paper abstracts. Falls back to keyword-based
    scoring if embeddings are unavailable.
    
    Args:
        papers: List of papers to score
        profile: User profile with interests
        
    Returns:
        Dictionary mapping paper_id to embedding score (0.0-1.0)
    """
    # Try to use embedding model (singleton pattern - model loaded once)
    model = _get_embedding_model()
    if model is not None and HAS_SKLEARN and HAS_NUMPY:
        try:
            # Build weighted average embedding from interest groups
            # Each group (primary, secondary, exploratory) is encoded separately,
            # then combined using weighted average for mathematically accurate representation
            
            # Get embedding dimension from a test encode
            test_embedding = model.encode(["test"])
            embedding_dim = test_embedding.shape[1]
            
            weighted_sum = np.zeros(embedding_dim)
            total_weight = 0.0
            
            for group_name, weight in INTEREST_WEIGHTS.items():
                interests = profile["interests"].get(group_name, [])
                if interests:
                    # Encode all interests in this group
                    group_embeddings = model.encode(interests)
                    # Calculate mean embedding for this group
                    group_mean = np.mean(group_embeddings, axis=0)
                    # Add to weighted sum
                    weighted_sum += weight * group_mean
                    total_weight += weight
            
            # If no interests at all, return zero scores
            if total_weight == 0.0:
                return {paper["paper_id"]: 0.0 for paper in papers}
            
            # Calculate final weighted average embedding
            interests_embedding = weighted_sum / total_weight
            
            # Generate paper embeddings (batch processing)
            paper_texts = []
            paper_ids = []
            for paper in papers:
                paper_text = f"{paper.get('title', '')} {paper.get('abstract', '')}"
                paper_texts.append(paper_text)
                paper_ids.append(paper["paper_id"])
            
            # Batch encode all papers
            paper_embeddings = model.encode(paper_texts)
            
            # Calculate cosine similarity
            # Reshape interests_embedding for sklearn compatibility
            interests_embedding_2d = interests_embedding.reshape(1, -1)
            similarities = cosine_similarity(interests_embedding_2d, paper_embeddings)[0]
            
            # Convert to dictionary and normalize to 0.0-1.0 (cosine similarity is already -1.0 to 1.0)
            # Normalize: (similarity + 1) / 2 to get 0.0-1.0 range
            scores = {}
            for i, paper_id in enumerate(paper_ids):
                # Normalize cosine similarity to 0.0-1.0 range
                normalized_score = (similarities[i] + 1.0) / 2.0
                scores[paper_id] = max(0.0, min(1.0, normalized_score))  # Clamp to [0, 1]
            
            return scores
            
        except Exception:
            # If embedding fails, fall back to keyword scoring
            pass
    
    # Fallback to keyword-based scoring
    return _calculate_keyword_scores(papers, profile)


def _calculate_keyword_scores(
    papers: List[PaperInput],
    profile: UserProfile
) -> Dict[str, float]:
    """
    Calculate keyword-based relevance scores for papers (fallback method).
    
    Uses simple term frequency (TF) style counting of interest keywords
    appearing in paper abstracts.
    
    Args:
        papers: List of papers to score
        profile: User profile with interests
        
    Returns:
        Dictionary mapping paper_id to keyword score (0.0-1.0)
    """
    # Collect all interest keywords with weights
    interest_keywords = {}
    
    # Primary interests: weight 1.0
    for keyword in profile["interests"]["primary"]:
        keyword_lower = keyword.lower()
        interest_keywords[keyword_lower] = interest_keywords.get(keyword_lower, 0.0) + 1.0
    
    # Secondary interests: weight 0.7
    for keyword in profile["interests"]["secondary"]:
        keyword_lower = keyword.lower()
        interest_keywords[keyword_lower] = interest_keywords.get(keyword_lower, 0.0) + 0.7
    
    # Exploratory interests: weight 0.4
    for keyword in profile["interests"]["exploratory"]:
        keyword_lower = keyword.lower()
        interest_keywords[keyword_lower] = interest_keywords.get(keyword_lower, 0.0) + 0.4
    
    # If no keywords, return zero scores
    if not interest_keywords:
        return {paper["paper_id"]: 0.0 for paper in papers}
    
    # Calculate scores for each paper
    scores = {}
    max_score = 0.0
    
    for paper in papers:
        paper_id = paper["paper_id"]
        abstract = paper.get("abstract", "").lower()
        title = paper.get("title", "").lower()
        text = f"{title} {abstract}"
        
        # Count keyword occurrences with weights
        score = 0.0
        for keyword, weight in interest_keywords.items():
            # Count occurrences of keyword in text
            count = text.count(keyword)
            score += count * weight
        
        scores[paper_id] = score
        max_score = max(max_score, score)
    
    # Normalize scores to 0.0-1.0 range
    if max_score > 0:
        normalized_scores = {
            paper_id: min(1.0, score / max_score)
            for paper_id, score in scores.items()
        }
        return normalized_scores
    else:
        # All scores are zero
        return {paper_id: 0.0 for paper_id in scores.keys()}


def _classify_papers_by_score(
    papers: List[PaperInput],
    scores: Dict[str, float]
) -> Tuple[List[PaperInput], List[PaperInput], List[PaperInput]]:
    """
    Classify papers into three groups based on their scores.
    
    Borderline thresholds are configurable via environment variables:
    - LLM_BORDERLINE_MIN (default: 0.4): Minimum score for mid_group (borderline)
    - LLM_BORDERLINE_MAX (default: 0.7): Minimum score for high_group
    
    Args:
        papers: List of papers to classify
        scores: Dictionary mapping paper_id to score
        
    Returns:
        Tuple of (high_group, mid_group, low_group) where:
        - high_group: papers with score >= LLM_BORDERLINE_MAX (default: 0.7)
        - mid_group: papers with LLM_BORDERLINE_MIN <= score < LLM_BORDERLINE_MAX (default: 0.4-0.7)
        - low_group: papers with score < LLM_BORDERLINE_MIN (default: < 0.4)
    """
    # Get borderline thresholds from environment variables
    borderline_min = float(os.getenv("LLM_BORDERLINE_MIN", "0.4"))
    borderline_max = float(os.getenv("LLM_BORDERLINE_MAX", "0.7"))
    
    high_group: List[PaperInput] = []
    mid_group: List[PaperInput] = []
    low_group: List[PaperInput] = []
    
    for paper in papers:
        paper_id = paper["paper_id"]
        score = scores.get(paper_id, 0.0)
        
        if score >= borderline_max:
            high_group.append(paper)
        elif score >= borderline_min:
            mid_group.append(paper)
        else:
            low_group.append(paper)
    
    return (high_group, mid_group, low_group)


def _extract_key_sentences(
    abstract: str,
    interests: Dict[str, List[str]],
    max_sentences: int = 5,
    max_length: int = 300
) -> str:
    """
    Extract key sentences from abstract for token-efficient LLM prompts.
    
    Prioritizes sentences that:
    1. Contain user interest keywords
    2. Are at the beginning or end of abstract (high information density)
    
    Args:
        abstract: Full abstract text
        interests: User interests dictionary (primary, secondary, exploratory)
        max_sentences: Maximum number of sentences to extract
        max_length: Maximum total character length
        
    Returns:
        Extracted key sentences as a string
    """
    if not abstract:
        return ""
    
    # Collect all user interest keywords
    all_keywords: Set[str] = set()
    for group in interests.values():
        all_keywords.update([kw.lower().strip() for kw in group if kw])
    
    # Split into sentences (simple approach: split by period, exclamation, question mark)
    import re
    sentences = re.split(r'[.!?]+', abstract)
    sentences = [s.strip() for s in sentences if s.strip()]
    
    if not sentences:
        # Fallback: return first part of abstract
        return abstract[:max_length] + ("..." if len(abstract) > max_length else "")
    
    # Score sentences
    scored_sentences = []
    for idx, sent in enumerate(sentences):
        score = 0.0
        sent_lower = sent.lower()
        
        # Keyword matching score
        for keyword in all_keywords:
            if keyword in sent_lower:
                score += 1.0
        
        # Position weight (first and last sentences are important)
        if idx == 0:
            score += 2.0  # First sentence
        elif idx == len(sentences) - 1:
            score += 2.0  # Last sentence
        elif idx < 3:
            score += 1.0  # Early sentences
        
        scored_sentences.append((score, idx, sent))
    
    # Sort by score (descending)
    scored_sentences.sort(key=lambda x: x[0], reverse=True)
    
    # Select top sentences
    selected = scored_sentences[:max_sentences]
    # Sort back by original position
    selected.sort(key=lambda x: x[1])
    
    # Combine selected sentences
    result = ". ".join([s[2] for s in selected])
    
    # Truncate if too long
    if len(result) > max_length:
        result = result[:max_length].rsplit('.', 1)[0] + "..."
    
    return result


async def _verify_with_llm(
    papers: List[PaperInput],
    profile: UserProfile,
    batch_size: int = 5,
    use_key_sentences: bool = True
) -> Dict[str, Tuple[float, str]]:
    """
    Verify paper relevance using LLM batch evaluation.
    
    Args:
        papers: List of papers to verify
        profile: User profile with interests
        batch_size: Number of papers per LLM batch call
        
    Returns:
        Dictionary mapping paper_id to (llm_score, reason) tuple.
        If LLM verification fails for a paper, returns (0.0, "") for that paper.
    """
    if not HAS_OPENAI or AsyncOpenAI is None:
        # If OpenAI is not available, return empty results
        return {paper["paper_id"]: (0.0, "") for paper in papers}
    
    try:
        client = build_async_openai_client()
        model = "gpt-4o"
    except Exception:
        return {paper["paper_id"]: (0.0, "") for paper in papers}
    
    # Get Borderline range from environment variables
    borderline_min = float(os.getenv("LLM_BORDERLINE_MIN", "0.4"))
    borderline_max = float(os.getenv("LLM_BORDERLINE_MAX", "0.7"))
    
    # Filter papers to only Borderline cases (if we have embedding scores)
    # For now, we'll verify all papers in the batch, but this can be optimized
    # by passing embedding_scores as a parameter
    
    results: Dict[str, Tuple[float, str]] = {}
    
    # Split papers into batches
    for i in range(0, len(papers), batch_size):
        batch = papers[i:i + batch_size]
        
        # Build prompt
        primary_interests = ", ".join(profile["interests"]["primary"]) if profile["interests"]["primary"] else "None"
        secondary_interests = ", ".join(profile["interests"]["secondary"]) if profile["interests"]["secondary"] else "None"
        
        prompt = f"""사용자 연구 관심사:

- Primary: {primary_interests}
- Secondary: {secondary_interests}

다음 논문들이 위 관심사와 얼마나 관련있는지 평가하세요.
각 논문에 대해 0.0~1.0 점수와 한 줄 판단 근거를 JSON으로 제공하세요.

논문 목록:

"""
        
        for idx, paper in enumerate(batch, start=1):
            paper_id = paper.get("paper_id", "")
            title = paper.get("title", "")
            
            # Use key sentences extraction if enabled
            if use_key_sentences:
                abstract_text = _extract_key_sentences(
                    paper.get("abstract", ""),
                    profile.get("interests", {})
                )
            else:
                abstract_text = paper.get("abstract", "")[:500]  # Fallback: limit length
            
            prompt += f"{idx}. [ID: {paper_id}] 제목: {title} / 초록: {abstract_text}\n\n"
        
        prompt += """응답 형식:
[{{"paper_id": "...", "relevance": 0.75, "reason": "..."}}, ...]
"""
        
        try:
            # Call LLM (async)
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You are a research paper evaluation assistant. Always respond with valid JSON array."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3
            )
            
            content = response.choices[0].message.content.strip()
            
            # Parse JSON response
            # Try to extract JSON from markdown code blocks if present
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            
            evaluations = json.loads(content)
            
            # Process evaluations
            if isinstance(evaluations, list):
                for eval_item in evaluations:
                    if isinstance(eval_item, dict):
                        paper_id = eval_item.get("paper_id", "")
                        relevance = eval_item.get("relevance", 0.0)
                        reason = eval_item.get("reason", "")
                        
                        # Clamp relevance to [0.0, 1.0]
                        relevance = max(0.0, min(1.0, float(relevance)))
                        
                        results[paper_id] = (relevance, reason)
            
        except (json.JSONDecodeError, KeyError, ValueError, AttributeError) as e:
            # If parsing fails, keep existing embedding scores (will be handled by caller)
            # Mark all papers in this batch as failed
            for paper in batch:
                paper_id = paper.get("paper_id", "")
                if paper_id not in results:
                    results[paper_id] = (0.0, "")
            continue
        except Exception as e:
            # Any other error, mark batch as failed
            for paper in batch:
                paper_id = paper.get("paper_id", "")
                if paper_id not in results:
                    results[paper_id] = (0.0, "")
            continue
    
    # Ensure all papers have results
    for paper in papers:
        paper_id = paper.get("paper_id", "")
        if paper_id not in results:
            results[paper_id] = (0.0, "")
    
    return results


def _merge_scores(
    embedding_scores: Dict[str, float],
    llm_results: Dict[str, Tuple[float, str]],
    high_group_ids: Set[str],
    low_group_ids: Set[str]
) -> Dict[str, Dict]:
    """
    Merge embedding scores and LLM verification results.
    
    Args:
        embedding_scores: Dictionary mapping paper_id to embedding score (0.0-1.0)
        llm_results: Dictionary mapping paper_id to (llm_score, reason) tuple
        high_group_ids: Set of paper IDs in high group (score >= 0.7)
        low_group_ids: Set of paper IDs in low group (score < 0.4)
        
    Returns:
        Dictionary mapping paper_id to {
            "semantic_score": float,
            "evaluation_method": str,
            "llm_reason": Optional[str]
        }
    """
    merged_scores: Dict[str, Dict] = {}
    
    # Get all paper IDs from embedding_scores
    all_paper_ids = set(embedding_scores.keys())
    
    # mid_group_ids = all papers not in high or low groups
    mid_group_ids = all_paper_ids - high_group_ids - low_group_ids
    
    for paper_id in all_paper_ids:
        embedding_score = embedding_scores.get(paper_id, 0.0)
        
        if paper_id in high_group_ids:
            # High group: use embedding score as-is
            merged_scores[paper_id] = {
                "semantic_score": embedding_score,
                "evaluation_method": "embedding_high",
                "llm_reason": None
            }
        elif paper_id in low_group_ids:
            # Low group: use embedding score as-is
            merged_scores[paper_id] = {
                "semantic_score": embedding_score,
                "evaluation_method": "embedding_low",
                "llm_reason": None
            }
        else:
            # Mid group: use LLM score if available, otherwise embedding score
            if paper_id in llm_results and llm_results[paper_id][0] > 0.0:
                llm_score, llm_reason = llm_results[paper_id]
                merged_scores[paper_id] = {
                    "semantic_score": llm_score,
                    "evaluation_method": "embedding+llm",
                    "llm_reason": llm_reason if llm_reason else None
                }
            else:
                # LLM verification failed or not available, use embedding score
                merged_scores[paper_id] = {
                    "semantic_score": embedding_score,
                    "evaluation_method": "embedding_only",
                    "llm_reason": None
                }
    
    return merged_scores


def _calculate_dimension_scores(
    paper: PaperInput,
    profile: UserProfile,
    semantic_score: float,
    local_pdfs: Set[str]
) -> Dict[str, float]:
    """
    Calculate 6-dimensional scores for a paper.
    
    Args:
        paper: Paper input object
        profile: User profile with keywords, preferred authors/institutions
        semantic_score: Pre-calculated semantic relevance score (0.0-1.0)
        local_pdfs: Set of paper IDs available locally
        
    Returns:
        Dictionary with 6 dimension scores:
        {
            "semantic_relevance": float,
            "must_keywords": float,
            "author_trust": float,
            "institution_trust": float,
            "recency": float,
            "practicality": float
        }
    """
    paper_id = paper.get("paper_id", "")
    title = paper.get("title", "").lower()
    abstract = paper.get("abstract", "").lower()
    authors = paper.get("authors", [])
    affiliations = paper.get("affiliations", [])
    published = paper.get("published", "")
    github_url = paper.get("github_url", "")
    
    scores: Dict[str, float] = {}
    
    # 1. semantic_relevance: Use provided semantic_score
    scores["semantic_relevance"] = semantic_score
    
    # 2. must_keywords: Ratio of must_include keywords found
    must_keywords = profile["keywords"]["must_include"]
    if not must_keywords:
        scores["must_keywords"] = 1.0  # No requirements = perfect score
    else:
        text_to_check = f"{title} {abstract}"
        found_count = 0
        for keyword in must_keywords:
            if keyword.lower() in text_to_check:
                found_count += 1
        scores["must_keywords"] = found_count / len(must_keywords)
    
    # 3. author_trust: Check if any preferred author is in authors list
    # Uses word boundary regex to avoid false positives (e.g., "Lee" matching "Leeann")
    preferred_authors = profile["preferred_authors"]
    if not preferred_authors:
        scores["author_trust"] = 1.0  # No preferences = perfect score
    else:
        found = False
        for pref_author in preferred_authors:
            # Escape special regex characters and create word boundary pattern
            pref_author_escaped = re.escape(pref_author.strip())
            # Use word boundary \b for exact word matching (case-insensitive)
            pattern = rf'\b{pref_author_escaped}\b'
            
            for paper_author in authors:
                if re.search(pattern, paper_author, re.IGNORECASE):
                    found = True
                    break
            if found:
                break
        
        scores["author_trust"] = 1.0 if found else 0.0
    
    # 4. institution_trust: Check preferred_institutions against affiliations
    # Uses word boundary regex to avoid false positives
    preferred_institutions = profile["preferred_institutions"]
    if not preferred_institutions:
        scores["institution_trust"] = 1.0  # No preferences = perfect score
    elif not affiliations:
        scores["institution_trust"] = 0.0  # No affiliations = no trust
    else:
        found = False
        for pref_inst in preferred_institutions:
            # Escape special regex characters and create word boundary pattern
            pref_inst_escaped = re.escape(pref_inst.strip())
            # Use word boundary \b for exact word matching (case-insensitive)
            pattern = rf'\b{pref_inst_escaped}\b'
            
            for aff in affiliations:
                if re.search(pattern, aff, re.IGNORECASE):
                    found = True
                    break
            if found:
                break
        
        scores["institution_trust"] = 1.0 if found else 0.0
    
    # 5. recency: Calculate based on published date using exponential decay
    # Formula: score = exp(-λ * days) where λ is the decay rate
    # λ is calibrated so that score ≈ 0.1 at 365 days: λ = -ln(0.1) / 365 ≈ 0.0063
    RECENCY_DECAY_RATE = 0.0063  # Decay rate (λ)
    RECENCY_MIN_SCORE = 0.05    # Minimum score floor for very old papers
    
    if not published:
        scores["recency"] = RECENCY_MIN_SCORE  # No date = assume very old
    else:
        try:
            # Parse date - handle both YYYY-MM-DD and ISO 8601 formats (e.g., "2025-06-27T10:15:33+00:00")
            # Extract date part if timezone info is present
            if 'T' in published:
                # ISO 8601 format: extract date part before 'T'
                pub_date_str = published.split('T')[0]
            elif ' ' in published:
                # Space-separated format: extract date part before space
                pub_date_str = published.split(' ')[0]
            else:
                # Simple YYYY-MM-DD format
                pub_date_str = published
            
            pub_date = datetime.strptime(pub_date_str, "%Y-%m-%d")
            now = datetime.now()
            time_diff = now - pub_date
            
            days_diff = max(0, time_diff.days)  # Ensure non-negative
            
            # Exponential decay: score = exp(-λ * days)
            # This provides smooth, continuous decay instead of step function
            recency_score = math.exp(-RECENCY_DECAY_RATE * days_diff)
            
            # Clamp to [RECENCY_MIN_SCORE, 1.0]
            scores["recency"] = max(RECENCY_MIN_SCORE, min(1.0, recency_score))
            
        except (ValueError, TypeError):
            # Invalid date format
            scores["recency"] = RECENCY_MIN_SCORE
    
    # 6. practicality: github_url + local_pdfs
    # Note: github_url is used for scoring (bonus points) only, not for filtering.
    # Filtering based on code requirement is disabled in filters.py (Phase 4 commented out)
    # because there's no tool to verify github_url existence yet. Will be uncommented after team discussion.
    practicality = 0.0
    if github_url and github_url.strip():
        practicality += 0.5
    if paper_id in local_pdfs:
        practicality += 0.3
    scores["practicality"] = min(1.0, practicality)  # Clamp to max 1.0
    
    return scores


def _apply_soft_penalty(
    paper: PaperInput,
    profile: UserProfile
) -> Tuple[float, List[str]]:
    """
    Apply soft penalty based on exclude keywords in title/abstract.
    
    Args:
        paper: Paper input object
        profile: User profile with soft exclude keywords
        
    Returns:
        Tuple of (total_penalty, matched_keywords_list)
        - total_penalty: Negative value (e.g., -0.15, -0.30)
        - matched_keywords_list: List of keywords that matched
    """
    title = paper.get("title", "").lower()
    abstract = paper.get("abstract", "").lower()
    text_to_check = f"{title} {abstract}"
    
    soft_keywords = profile["keywords"]["exclude"]["soft"]
    matched_keywords: List[str] = []
    
    for keyword in soft_keywords:
        if keyword.lower() in text_to_check:
            matched_keywords.append(keyword)
    
    # Calculate penalty: -0.15 per keyword, maximum -0.3
    penalty_per_keyword = -0.15
    max_penalty = -0.3
    
    # Calculate penalty: if no matches, penalty is 0.0; otherwise apply per-keyword penalty up to max
    calculated_penalty = len(matched_keywords) * penalty_per_keyword
    total_penalty = max(max_penalty, calculated_penalty)  # max(-0.3, calculated) ensures we don't go below -0.3, and 0.0 if no matches
    
    return (total_penalty, matched_keywords)


def _calculate_final_score(
    dimension_scores: Dict[str, float],
    soft_penalty: float,
    purpose: str,
    ranking_mode: str
) -> float:
    """
    Calculate final score from dimension scores with weights and penalty.
    
    Args:
        dimension_scores: Dictionary with 6 dimension scores
        soft_penalty: Soft penalty value (negative, e.g., -0.15)
        purpose: Research purpose ("general", "literature_review", etc.)
        ranking_mode: Ranking mode ("balanced", "novelty", "practicality", "diversity")
        
    Returns:
        Final score (0.0-1.0, but may exceed 1.0 if penalty is applied)
    """
    # Get base weights for purpose
    base_weights = WEIGHTS.get(purpose, WEIGHTS["general"]).copy()
    
    # Apply ranking_mode adjustments
    if ranking_mode == "novelty":
        # Increase recency weight, decrease author/institution weights
        base_weights["recency"] += 0.1
        base_weights["author"] = max(0.0, base_weights["author"] - 0.05)
        base_weights["institution"] = max(0.0, base_weights["institution"] - 0.05)
    elif ranking_mode == "practicality":
        # Increase practicality weight, decrease recency weight
        base_weights["practicality"] += 0.1
        base_weights["recency"] = max(0.0, base_weights["recency"] - 0.1)
    # "diversity" and "balanced" modes: no adjustment (handled in Phase 6 for diversity)
    
    # Normalize weights to sum to 1.0 (in case adjustments changed the sum)
    total_weight = sum(base_weights.values())
    if total_weight > 0:
        normalized_weights = {k: v / total_weight for k, v in base_weights.items()}
    else:
        normalized_weights = base_weights
    
    # Map dimension score keys to weight keys
    score_key_mapping = {
        "semantic_relevance": "semantic",
        "must_keywords": "must_kw",
        "author_trust": "author",
        "institution_trust": "institution",
        "recency": "recency",
        "practicality": "practicality"
    }
    
    # Calculate weighted sum
    final_score = 0.0
    for score_key, weight_key in score_key_mapping.items():
        score = dimension_scores.get(score_key, 0.0)
        weight = normalized_weights.get(weight_key, 0.0)
        final_score += score * weight
    
    # Apply soft penalty
    final_score += soft_penalty
    
    # Clamp to reasonable range (allow slightly negative but not too much)
    final_score = max(-0.5, min(1.5, final_score))
    
    return final_score

