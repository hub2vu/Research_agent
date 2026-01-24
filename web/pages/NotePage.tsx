import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { executeTool } from '../lib/mcp';
import { marked } from 'marked';

// Configure marked for note rendering
marked.setOptions({ breaks: true, gfm: true });

// Vite 호환 worker 설정
GlobalWorkerOptions.workerSrc = workerSrc;

type PdfDoc = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<any>;
  destroy?: () => Promise<void> | void;
};

type PdfLoadResult = {
  usedId: string;
  url: string;
  doc: PdfDoc;
};

interface NoteItem {
  id: string;
  title: string;
  content: string;
  isOpen: boolean;
}

function stripPrefixes(id: string): string {
  return String(id ?? '').replace(/^(paper:|ref:)/i, '').trim();
}

function normalizeArxivToDoiLike(id: string): string {
  if (id.startsWith('10.48550_arxiv.')) return id;
  const m = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (m) return `10.48550_arxiv.${m[1]}`;
  return id;
}

async function resolveAndLoadPdf(paperIdRaw: string): Promise<PdfLoadResult> {
  const cleaned = stripPrefixes(paperIdRaw);
  const candidates = [cleaned, normalizeArxivToDoiLike(cleaned)].filter((v, i, a) => a.indexOf(v) === i);

  const tried: string[] = [];
  const errors: string[] = [];

  for (const id of candidates) {
    const urlCandidates = [
      `/output/${id}/paper.pdf`,
      `/output/${id}/${id}.pdf`,
      `/output/${id}/main.pdf`,
      `/pdf/${id}.pdf`,
      `/pdf/neurips2025/${id}.pdf`
    ];

    for (const url of urlCandidates) {
      tried.push(url);
      try {
        const loadingTask: any = getDocument(url);
        const doc: PdfDoc = await loadingTask.promise;
        return { usedId: id, url, doc };
      } catch (err) {
        errors.push(`${url} (${String(err)})`);
      }
    }
  }

  throw new Error(
    [
      'PDF를 불러올 수 없습니다.',
      '',
      '확인해보세요:',
      '- /output/{paperId}/paper.pdf 또는 /pdf/{paperId}.pdf 존재 여부',
      '- noteId(paperId)가 폴더명/파일명과 정확히 일치하는지 확인',
      '',
      `시도한 후보 URL: ${tried.join(' | ')}`,
      errors.length ? '' : '',
      errors.length ? `에러 로그:\n${errors.join('\n')}` : ''
    ].join('\n')
  );
}

function generateId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function NotePage(props: { noteId?: string } = {}) {
  const params = useParams();

  const rawFromRoute = (params as any).paperId ?? '';
  const raw = props.noteId ?? rawFromRoute ?? '';
  const paperId = decodeURIComponent(String(raw));

  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [usedId, setUsedId] = useState<string>('');
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [pdfDoc, setPdfDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);

  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const pdfDocRef = useRef<PdfDoc | null>(null);

  // Resizable panel state
  const [panelRatio, setPanelRatio] = useState<number>(0.6); // left panel ratio (0.3 - 0.8)
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Notes state
  const notesStorageKey = useMemo(() => `notes:${usedId || stripPrefixes(paperId)}`, [usedId, paperId]);
  const [notes, setNotes] = useState<NoteItem[]>([]);

  // Loading states for extraction, translation, and analysis
  const [extracting, setExtracting] = useState(false);
  const [translatingNoteId, setTranslatingNoteId] = useState<string | null>(null);
  const [analyzingNoteId, setAnalyzingNoteId] = useState<string | null>(null);

  // Load notes from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(notesStorageKey);
      if (stored) {
        setNotes(JSON.parse(stored));
      } else {
        setNotes([]);
      }
    } catch {
      setNotes([]);
    }
  }, [notesStorageKey]);

  // Save notes to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(notesStorageKey, JSON.stringify(notes));
    } catch {
      // ignore
    }
  }, [notes, notesStorageKey]);

  // PDF loading
  useEffect(() => {
    const cleaned = stripPrefixes(paperId);

    if (!cleaned) {
      setError('paperId가 비어 있습니다. 라우트 파라미터(/note/:paperId)를 확인하세요.');
      setLoading(false);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        if (pdfDocRef.current?.destroy) await pdfDocRef.current.destroy();
      } catch {
        // ignore
      }
      pdfDocRef.current = null;
      setPdfDoc(null);
      setPageCount(0);
      setPdfUrl('');
      setUsedId('');

      try {
        const res = await resolveAndLoadPdf(cleaned);
        if (cancelled) {
          try { if (res.doc.destroy) await res.doc.destroy(); } catch {}
          return;
        }
        pdfDocRef.current = res.doc;
        setUsedId(res.usedId);
        setPdfUrl(res.url);
        setPdfDoc(res.doc);
        setPageCount(res.doc.numPages);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      try {
        if (pdfDocRef.current?.destroy) pdfDocRef.current.destroy();
      } catch {
        // ignore
      }
    };
  }, [paperId]);

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);

  // PDF rendering
  useEffect(() => {
    if (!pdfDoc || pageCount <= 0) return;

    let cancelled = false;

    const renderPages = async () => {
      for (const pageNumber of pages) {
        if (cancelled) return;

        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.2 });

        const canvas = canvasRefs.current[pageNumber - 1];
        if (!canvas) continue;

        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        const outputScale = window.devicePixelRatio || 1;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const transform =
          outputScale !== 1 ? ([outputScale, 0, 0, outputScale, 0, 0] as [number, number, number, number, number, number]) : undefined;

        await page.render({ canvasContext: ctx, viewport, transform }).promise;
      }
    };

    renderPages().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pages, pageCount]);

  // Drag handlers for resizable divider
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setPanelRatio(Math.max(0.3, Math.min(0.8, ratio)));
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Note CRUD operations
  const addNote = useCallback(() => {
    const newNote: NoteItem = {
      id: generateId(),
      title: '새 노트',
      content: '',
      isOpen: true,
    };
    setNotes(prev => [...prev, newNote]);
  }, []);

  const deleteNote = useCallback((noteId: string) => {
    setNotes(prev => prev.filter(n => n.id !== noteId));
  }, []);

  const toggleNote = useCallback((noteId: string) => {
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, isOpen: !n.isOpen } : n));
  }, []);

  const updateNoteTitle = useCallback((noteId: string, title: string) => {
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, title } : n));
  }, []);

  const updateNoteContent = useCallback((noteId: string, content: string) => {
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, content } : n));
  }, []);

  // Extract chapter headings via LLM chat and create notes
  const extractHeadings = useCallback(async () => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    setExtracting(true);
    try {
      // 1. Fetch extracted_text.txt for the paper
      const textUrl = `/output/${id}/extracted_text.txt`;
      const textRes = await fetch(textUrl);
      if (!textRes.ok) {
        alert(`텍스트 파일을 불러올 수 없습니다: ${textUrl}`);
        return;
      }
      const extractedText = await textRes.text();
      if (!extractedText.trim()) {
        alert('추출된 텍스트가 비어 있습니다.');
        return;
      }

      // 2. Send to LLM chat to extract subtitles
      const prompt = `다음 논문 텍스트에서 소목차(section/subsection headings)를 추출해주세요.
규칙:
- 한 줄에 하나의 소목차만 출력
- 번호가 있으면 번호 포함 (예: "1. Introduction", "2.1 Background")
- 소목차 외의 설명이나 부연은 절대 추가하지 마세요
- 목차 제목만 순서대로 나열해주세요

논문 텍스트:
${extractedText.slice(0, 15000)}`;

      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, history: [] }),
      });

      if (!chatRes.ok) {
        alert(`LLM 채팅 요청 실패: HTTP ${chatRes.status}`);
        return;
      }

      const chatData = await chatRes.json();
      const responseText = chatData.response || '';

      // 3. Parse each line as a subtitle
      const headings = responseText
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0);

      if (headings.length === 0) {
        alert('추출된 소목차가 없습니다.');
        return;
      }

      // 4. Create notes from extracted subtitles
      const newNotes: NoteItem[] = headings.map((title: string) => ({
        id: generateId(),
        title,
        content: '',
        isOpen: true,
      }));
      setNotes(newNotes);
    } catch (e) {
      alert(`소목차 추출 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExtracting(false);
    }
  }, [usedId, paperId]);

  // Translate a specific note's section using extracted_text.txt
  const translateSection = useCallback(async (noteId: string, sectionTitle: string) => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    setTranslatingNoteId(noteId);
    try {
      // Find the next note's title for boundary detection
      const noteIndex = notes.findIndex(n => n.id === noteId);
      const nextSectionTitle = noteIndex >= 0 && noteIndex < notes.length - 1
        ? notes[noteIndex + 1].title
        : '';

      const result = await executeTool('translate_section', {
        paper_id: id,
        section_title: sectionTitle,
        next_section_title: nextSectionTitle,
        target_language: 'Korean',
      });
      if (!result.success) {
        alert(`번역 실패: ${result.error || 'Unknown error'}`);
        return;
      }

      const translatedText = result.result?.translated_text || '';
      updateNoteContent(noteId, translatedText);
    } catch (e) {
      alert(`번역 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranslatingNoteId(null);
    }
  }, [usedId, paperId, notes, updateNoteContent]);

  // Analyze a specific note's section using page_analyzer
  const analyzeSection = useCallback(async (noteId: string, sectionTitle: string) => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    setAnalyzingNoteId(noteId);
    try {
      const noteIndex = notes.findIndex(n => n.id === noteId);
      const nextSectionTitle = noteIndex >= 0 && noteIndex < notes.length - 1
        ? notes[noteIndex + 1].title
        : '';

      const result = await executeTool('analyze_section', {
        paper_id: id,
        section_title: sectionTitle,
        next_section_title: nextSectionTitle,
      });
      if (!result.success) {
        alert(`분석 실패: ${result.error || 'Unknown error'}`);
        return;
      }

      const analysisText = result.result?.analysis_text || '';
      updateNoteContent(noteId, analysisText);
    } catch (e) {
      alert(`분석 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAnalyzingNoteId(null);
    }
  }, [usedId, paperId, notes, updateNoteContent]);

  return (
    <div ref={containerRef} style={{ display: 'flex', height: '100vh', backgroundColor: '#f5f5f5' }}>
      <style>{`
        .markdown-preview h1 { font-size: 1.4em; font-weight: 700; margin: 12px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
        .markdown-preview h2 { font-size: 1.2em; font-weight: 700; margin: 10px 0 6px; }
        .markdown-preview h3 { font-size: 1.1em; font-weight: 600; margin: 8px 0 4px; }
        .markdown-preview p { margin: 6px 0; }
        .markdown-preview strong { font-weight: 700; }
        .markdown-preview em { font-style: italic; }
        .markdown-preview ul, .markdown-preview ol { margin: 6px 0; padding-left: 20px; }
        .markdown-preview li { margin: 3px 0; }
        .markdown-preview code { background: #edf2f7; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; font-family: monospace; }
        .markdown-preview pre { background: #1a202c; color: #e2e8f0; padding: 10px 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
        .markdown-preview pre code { background: none; padding: 0; color: inherit; }
        .markdown-preview blockquote { border-left: 3px solid #cbd5e0; padding-left: 12px; margin: 8px 0; color: #4a5568; }
        .markdown-preview hr { border: none; border-top: 1px solid #e2e8f0; margin: 12px 0; }
        .markdown-preview a { color: #3182ce; text-decoration: underline; }
        .markdown-preview table { border-collapse: collapse; margin: 8px 0; width: 100%; }
        .markdown-preview th, .markdown-preview td { border: 1px solid #e2e8f0; padding: 6px 10px; font-size: 12px; }
        .markdown-preview th { background: #f7fafc; font-weight: 600; }
      `}</style>
      {/* Left: PDF paper view */}
      <div style={{ width: `${panelRatio * 100}%`, display: 'flex', flexDirection: 'column', minWidth: 300 }}>
        <header
          style={{
            padding: '16px 20px',
            backgroundColor: '#fff',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <div>
            <button
              onClick={() => navigate(-1)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                backgroundColor: '#edf2f7',
                border: 'none',
                cursor: 'pointer',
                marginRight: '12px'
              }}
            >
              ← Back
            </button>
            <span style={{ fontWeight: 700 }}>Paper View</span>
          </div>

          <div style={{ fontSize: 12, color: '#718096', textAlign: 'right' }}>
            <div>noteId: {paperId}</div>
            {usedId && <div>usedId: {usedId}</div>}
            {pdfUrl && <div>pdf source: {pdfUrl}</div>}
            {pageCount > 0 && <div>pages: {pageCount}</div>}
          </div>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
          {loading && <div style={{ color: '#718096', fontSize: 14, padding: '12px 0' }}>PDF를 불러오는 중…</div>}

          {error && (
            <pre
              style={{
                background: '#fff',
                border: '1px solid #fed7d7',
                color: '#c53030',
                padding: 12,
                borderRadius: 8,
                whiteSpace: 'pre-wrap'
              }}
            >
              {error}
            </pre>
          )}

          {!loading && !error && pageCount === 0 && (
            <div style={{ color: '#718096', fontSize: 14 }}>
              PDF 페이지를 찾을 수 없습니다. (/output/{'{paperId}'}/paper.pdf 또는 /pdf/{'{paperId}'}.pdf 확인)
            </div>
          )}

          {!loading && !error && pageCount > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16 }}>
              {pages.map((pageNumber) => (
                <div key={`page-${pageNumber}`} style={{ marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, margin: '8px 0 10px', color: '#2d3748' }}>Page {pageNumber}</div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <canvas
                      ref={(el) => {
                        canvasRefs.current[pageNumber - 1] = el;
                      }}
                      style={{
                        maxWidth: '100%',
                        borderRadius: 8,
                        border: '1px solid #edf2f7',
                        background: '#fff'
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Resizable divider */}
      <div
        onMouseDown={handleDragStart}
        style={{
          width: 6,
          cursor: 'col-resize',
          backgroundColor: '#e2e8f0',
          transition: 'background-color 0.15s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#cbd5e0'; }}
        onMouseLeave={(e) => { if (!isDragging.current) (e.currentTarget as HTMLDivElement).style.backgroundColor = '#e2e8f0'; }}
      >
        <div style={{ width: 2, height: 40, borderRadius: 1, backgroundColor: '#a0aec0' }} />
      </div>

      {/* Right: Note panel */}
      <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            padding: '12px 20px',
            backgroundColor: '#fff',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 15 }}>논문 분석 노트</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={extractHeadings}
              disabled={extracting || loading}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                border: '1px solid #e2e8f0',
                backgroundColor: extracting ? '#edf2f7' : '#ebf8ff',
                color: extracting ? '#a0aec0' : '#2b6cb0',
                cursor: extracting ? 'not-allowed' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
              title="논문 소목차를 추출하여 노트를 생성합니다"
            >
              {extracting ? '추출 중...' : '소목차 추출'}
            </button>
            <button
              onClick={addNote}
              style={{
                padding: '5px 12px',
                borderRadius: 6,
                border: '1px solid #e2e8f0',
                backgroundColor: '#f0fff4',
                color: '#276749',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 700,
              }}
              title="새 노트 추가"
            >
              +
            </button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {notes.length === 0 && (
            <div style={{ color: '#a0aec0', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
              노트가 없습니다. "+" 버튼 또는 "소목차 추출" 버튼으로 노트를 추가하세요.
            </div>
          )}

          {notes.map((note) => (
            <div
              key={note.id}
              style={{
                backgroundColor: '#fff',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {/* Note header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 12px',
                  backgroundColor: '#f7fafc',
                  borderBottom: note.isOpen ? '1px solid #e2e8f0' : 'none',
                  gap: 8,
                }}
              >
                {/* Toggle button */}
                <button
                  onClick={() => toggleNote(note.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: '#718096',
                    padding: '2px 4px',
                    flexShrink: 0,
                  }}
                  title={note.isOpen ? '접기' : '펼치기'}
                >
                  {note.isOpen ? '▼' : '▶'}
                </button>

                {/* Editable title */}
                <input
                  type="text"
                  value={note.title}
                  onChange={(e) => updateNoteTitle(note.id, e.target.value)}
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#2d3748',
                    outline: 'none',
                    minWidth: 0,
                  }}
                  placeholder="제목 입력..."
                />

                {/* Analysis button */}
                <button
                  onClick={() => analyzeSection(note.id, note.title)}
                  disabled={analyzingNoteId === note.id || !note.title.trim()}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: analyzingNoteId === note.id ? '#edf2f7' : '#e9d8fd',
                    color: analyzingNoteId === note.id ? '#a0aec0' : '#553c9a',
                    cursor: analyzingNoteId === note.id ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title="이 섹션을 분석하여 해설합니다"
                >
                  {analyzingNoteId === note.id ? '분석 중...' : 'Analysis'}
                </button>

                {/* Translate button */}
                <button
                  onClick={() => translateSection(note.id, note.title)}
                  disabled={translatingNoteId === note.id || !note.title.trim()}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: translatingNoteId === note.id ? '#edf2f7' : '#fefcbf',
                    color: translatingNoteId === note.id ? '#a0aec0' : '#975a16',
                    cursor: translatingNoteId === note.id ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title="이 섹션을 한국어로 번역합니다"
                >
                  {translatingNoteId === note.id ? '번역 중...' : 'Translate'}
                </button>

                {/* Delete button */}
                <button
                  onClick={() => deleteNote(note.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 15,
                    color: '#e53e3e',
                    padding: '2px 6px',
                    flexShrink: 0,
                    lineHeight: 1,
                  }}
                  title="노트 삭제"
                >
                  ×
                </button>
              </div>

              {/* Note content (collapsible) */}
              {note.isOpen && (
                <div style={{ padding: 10 }}>
                  <textarea
                    value={note.content}
                    onChange={(e) => updateNoteContent(note.id, e.target.value)}
                    placeholder="마크다운으로 내용을 작성하세요..."
                    style={{
                      width: '100%',
                      minHeight: 80,
                      resize: 'vertical',
                      borderRadius: 6,
                      border: '1px solid #e2e8f0',
                      padding: 10,
                      fontSize: 13,
                      lineHeight: 1.6,
                      outline: 'none',
                      fontFamily: 'monospace',
                    }}
                  />
                  {note.content.trim() && (
                    <div
                      className="markdown-preview"
                      style={{
                        marginTop: 8,
                        padding: 10,
                        borderRadius: 6,
                        border: '1px solid #e2e8f0',
                        backgroundColor: '#fafafa',
                        fontSize: 13,
                        lineHeight: 1.7,
                        minHeight: 40,
                      }}
                      dangerouslySetInnerHTML={{ __html: marked.parse(note.content) as string }}
                    />
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Add note button at the bottom */}
          {notes.length > 0 && (
            <button
              onClick={addNote}
              style={{
                padding: '10px',
                borderRadius: 8,
                border: '2px dashed #e2e8f0',
                backgroundColor: 'transparent',
                color: '#a0aec0',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                textAlign: 'center',
                marginTop: 4,
              }}
            >
              + 노트 추가
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
