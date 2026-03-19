import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { executeTool, type SaveNotionNotesResult } from '../lib/mcp';
import NotionSaveModal from '../components/NotionSaveModal';
import { recordRecentPaper } from '../lib/recentPapers';

// PDF.js worker 설정 - CDN에서 로드 (Vite node_modules 접근 문제 해결)
type PdfLoadResult = {
  usedId: string;
  url: string;
};

interface SectionBoundary {
  startIndex: number;
  endIndex: number;
  sourceFile: 'json' | 'txt';
}

// 멀티 페이지 노트 구조: 각 기능별로 별도 저장
type NotePageType = 'manual' | 'translation' | 'analysis' | 'qa';

interface NotePages {
  manual: string;       // 사용자가 직접 작성한 메모
  translation?: string; // 번역 결과
  analysis?: string;    // 분석 결과
  qa?: string;          // QA 결과 (히스토리)
}

interface NoteItem {
  id: string;
  title: string;
  pages: NotePages;     // content → pages로 변경
  activePage: NotePageType;  // 현재 보이는 페이지
  isOpen: boolean;
  sectionBoundary?: SectionBoundary;
}

// 기존 content 형식과의 호환을 위한 마이그레이션 헬퍼
function migrateNoteItem(note: any): NoteItem {
  // 이미 새 형식인 경우
  if (note.pages && typeof note.pages === 'object') {
    return {
      ...note,
      pages: {
        manual: note.pages.manual || '',
        translation: note.pages.translation,
        analysis: note.pages.analysis,
        qa: note.pages.qa,
      },
      activePage: note.activePage || 'manual',
    };
  }
  // 구 형식(content)인 경우 마이그레이션
  return {
    id: note.id,
    title: note.title,
    pages: {
      manual: note.content || '',
    },
    activePage: 'manual',
    isOpen: note.isOpen !== undefined ? note.isOpen : true,
    sectionBoundary: note.sectionBoundary,
  };
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
        const response = await fetch(url, { method: 'HEAD' });
        if (response.ok) {
          return { usedId: id, url };
        }
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

interface NotePageProps {
  noteId?: string;
  onOpenAccountSettings?: () => void;
}

export default function NotePage(props: NotePageProps = {}) {
  const params = useParams();

  const rawFromRoute = (params as any).paperId ?? '';
  const raw = props.noteId ?? rawFromRoute ?? '';
  const paperId = decodeURIComponent(String(raw));

  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [usedId, setUsedId] = useState<string>('');
  const [pdfUrl, setPdfUrl] = useState<string>('');

  // Resizable panel state
  const [panelRatio, setPanelRatio] = useState<number>(0.6); // left panel ratio (0.3 - 0.8)
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Notes state
  const notesStorageKey = useMemo(() => `notes:${usedId || stripPrefixes(paperId)}`, [usedId, paperId]);
  const [notes, setNotes] = useState<NoteItem[]>([]);

  // Edit mode state: tracks which notes are in edit mode (default: preview)
  const [editingNoteIds, setEditingNoteIds] = useState<Set<string>>(new Set());

  const toggleEditMode = useCallback((noteId: string) => {
    setEditingNoteIds(prev => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  }, []);

  // Loading states for extraction, translation, analysis, prompt, and Notion
  const [extracting, setExtracting] = useState(false);
  const [translatingNoteId, setTranslatingNoteId] = useState<string | null>(null);
  const [analyzingNoteId, setAnalyzingNoteId] = useState<string | null>(null);
  const [promptingNoteId, setPromptingNoteId] = useState<string | null>(null);
  const [isNotionSaveModalOpen, setIsNotionSaveModalOpen] = useState(false);

  // Load notes from file system (priority) or localStorage (fallback)
  useEffect(() => {
    const loadNotes = async () => {
      const id = usedId || stripPrefixes(paperId);
      if (!id) {
        // Fallback to localStorage if no paper ID
        try {
          const stored = localStorage.getItem(notesStorageKey);
          if (stored) {
            const parsed = JSON.parse(stored);
            // 마이그레이션 적용
            setNotes(parsed.map(migrateNoteItem));
          } else {
            setNotes([]);
          }
        } catch {
          setNotes([]);
        }
        return;
      }

      try {
        // 1. Try loading from file system first (persistent storage)
        const notesFileUrl = `/output/${id}/notes/notes.json`;
        try {
          const fileRes = await fetch(notesFileUrl);
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            const fileNotes = fileData.notes || [];
            if (fileNotes.length > 0) {
              // 마이그레이션 적용하여 새 형식으로 변환
              const convertedNotes: NoteItem[] = fileNotes.map(migrateNoteItem);
              setNotes(convertedNotes);
              // Also update localStorage as cache
              try {
                localStorage.setItem(notesStorageKey, JSON.stringify(convertedNotes));
              } catch {}
              return; // File system data takes priority
            }
          }
        } catch (e) {
          console.log('File system notes not found, trying localStorage:', e);
        }

        // 2. Fallback to localStorage
        try {
          const stored = localStorage.getItem(notesStorageKey);
          if (stored) {
            const parsed = JSON.parse(stored);
            // 마이그레이션 적용
            setNotes(parsed.map(migrateNoteItem));
          } else {
            setNotes([]);
          }
        } catch {
          setNotes([]);
        }
      } catch (e) {
        console.error('Error loading notes:', e);
        setNotes([]);
      }
    };

    loadNotes();
  }, [notesStorageKey, usedId, paperId]);

  // Save notes to localStorage (cache) and file system
  useEffect(() => {
    if (notes.length === 0) return; // Don't save empty notes

    // Save to localStorage (for immediate access and cache)
    try {
      localStorage.setItem(notesStorageKey, JSON.stringify(notes));
    } catch {
      // ignore
    }

    // Save to file system (debounced to avoid too frequent saves)
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    const saveTimeout = setTimeout(async () => {
      try {
        const notesToSave = notes.map(n => ({
          id: n.id,
          title: n.title,
          pages: n.pages,  // 새 형식: pages 객체로 저장
          activePage: n.activePage,
          isOpen: n.isOpen,
          sectionBoundary: n.sectionBoundary,
        }));
        
        const result = await executeTool('save_notes', {
          paper_id: id,
          notes: notesToSave,
        });
        if (result.success) {
          console.log('Notes auto-saved to file system');
        }
      } catch (e) {
        console.error('Failed to auto-save notes:', e);
        // Non-blocking error - localStorage still works
      }
    }, 2000); // 2 second debounce

    return () => clearTimeout(saveTimeout);
  }, [notes, notesStorageKey, usedId, paperId]);

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
      setPdfUrl('');
      setUsedId('');

      try {
        const res = await resolveAndLoadPdf(cleaned);
        if (cancelled) {
          return;
        }
        setUsedId(res.usedId);
        setPdfUrl(res.url);
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
    };
  }, [paperId]);

  useEffect(() => {
    const currentPaperId = usedId || normalizeArxivToDoiLike(stripPrefixes(paperId));
    if (!currentPaperId) {
      return;
    }

    recordRecentPaper({
      paperId: currentPaperId,
      title: currentPaperId,
      venue: 'Notes',
      route: `/note/${encodeURIComponent(currentPaperId)}`
    });
  }, [usedId, paperId]);

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
      pages: { manual: '' },
      activePage: 'manual',
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

  // 현재 활성 페이지의 내용을 업데이트
  const updateNoteContent = useCallback((noteId: string, content: string) => {
    setNotes(prev => prev.map(n => {
      if (n.id !== noteId) return n;
      return {
        ...n,
        pages: {
          ...n.pages,
          [n.activePage]: content,
        }
      };
    }));
  }, []);

  // 특정 페이지의 내용을 업데이트
  const updateNotePage = useCallback((noteId: string, pageType: NotePageType, content: string) => {
    setNotes(prev => prev.map(n => {
      if (n.id !== noteId) return n;
      return {
        ...n,
        pages: {
          ...n.pages,
          [pageType]: content,
        }
      };
    }));
  }, []);

  // 활성 페이지 변경
  const setActivePage = useCallback((noteId: string, pageType: NotePageType) => {
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, activePage: pageType } : n));
  }, []);

  // 현재 노트의 활성 페이지 내용 가져오기
  const getActivePageContent = useCallback((note: NoteItem): string => {
    return note.pages[note.activePage] || '';
  }, []);

  // Load extracted text from JSON (preferred) or TXT file
  const loadExtractedText = useCallback(async (id: string): Promise<{ text: string; sourceFile: 'json' | 'txt' } | null> => {
    // Try JSON first (cleaner, no page markers)
    try {
      const jsonUrl = `/output/${id}/extracted_text.json`;
      const jsonRes = await fetch(jsonUrl);
      if (jsonRes.ok) {
        const data = await jsonRes.json();
        const fullText = data.full_text || '';
        if (fullText.trim()) {
          return { text: fullText, sourceFile: 'json' };
        }
      }
    } catch {
      // JSON failed, try TXT
    }

    // Fallback to TXT
    try {
      const txtUrl = `/output/${id}/extracted_text.txt`;
      const txtRes = await fetch(txtUrl);
      if (txtRes.ok) {
        let text = await txtRes.text();
        // Remove page markers
        text = text.replace(/===\s*Page\s*\d+\s*===\n*/g, '\n');
        text = text.replace(/\n{3,}/g, '\n\n');
        if (text.trim()) {
          return { text, sourceFile: 'txt' };
        }
      }
    } catch {
      // TXT also failed
    }

    return null;
  }, []);

  // Find section boundary for a note title by searching in extracted text
  // Only finds startIndex - endIndex is calculated from note order
  const findBoundaryForNote = useCallback(async (noteId: string, title: string) => {
    const id = usedId || stripPrefixes(paperId);
    if (!id || !title.trim()) return;

    try {
      const textData = await loadExtractedText(id);
      if (!textData) return;

      const { text: fullText, sourceFile } = textData;
      const fullTextLower = fullText.toLowerCase();
      
      // Normalize title for searching
      const normalizedTitle = title.trim();
      const normalizedTitleLower = normalizedTitle.toLowerCase();
      
      let startIndex = -1;
      
      // Strategy 1: Exact match (case insensitive)
      startIndex = fullTextLower.indexOf(normalizedTitleLower);
      console.log(`Strategy 1 (exact): "${normalizedTitle}" → ${startIndex}`);
      
      // Strategy 2: Match at line start with regex
      if (startIndex === -1) {
        const escapedTitle = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lineStartPattern = new RegExp(`^${escapedTitle}`, 'gim');
        const match = lineStartPattern.exec(fullText);
        if (match) {
          startIndex = match.index;
          console.log(`Strategy 2 (line start): found at ${startIndex}`);
        }
      }
      
      // Strategy 3: Search for section number at line start (e.g., "2.1" or "2.1.")
      if (startIndex === -1) {
        const numMatch = normalizedTitle.match(/^(\d+(?:\.\d+)*)/);
        if (numMatch) {
          const sectionNum = numMatch[1];
          const escapedNum = sectionNum.replace(/\./g, '\\.');
          // Try multiple patterns for section numbers
          const patterns = [
            new RegExp(`^${escapedNum}\\s+[A-Z]`, 'gm'),  // "2.1 Title"
            new RegExp(`^${escapedNum}\\.\\s+[A-Z]`, 'gm'), // "2.1. Title"
            new RegExp(`^${escapedNum}\\n[A-Z]`, 'gm'),  // "2.1\nTitle"
            new RegExp(`^${escapedNum}[\\s\\n]`, 'gm'),   // "2.1 " or "2.1\n"
          ];
          for (const pattern of patterns) {
            const match = pattern.exec(fullText);
            if (match) {
              startIndex = match.index;
              console.log(`Strategy 3 (section num "${sectionNum}"): found at ${startIndex}`);
              break;
            }
          }
        }
      }
      
      // Strategy 4: Search for title text without number prefix
      if (startIndex === -1) {
        const titleWithoutNum = normalizedTitle.replace(/^[\d.]+\s*/, '').trim();
        if (titleWithoutNum.length >= 3) {
          // Try exact match first
          let idx = fullTextLower.indexOf(titleWithoutNum.toLowerCase());
          if (idx !== -1) {
            startIndex = idx;
            console.log(`Strategy 4 (without num "${titleWithoutNum}"): found at ${startIndex}`);
          } else {
            // Try matching at line start
            const escapedText = titleWithoutNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`^${escapedText}`, 'gim');
            const match = pattern.exec(fullText);
            if (match) {
              startIndex = match.index;
              console.log(`Strategy 4b (line start without num): found at ${startIndex}`);
            }
          }
        }
      }
      
      // Strategy 5: Fuzzy search - find line containing all words
      if (startIndex === -1) {
        const words = normalizedTitleLower.split(/\s+/).filter(w => w.length > 2);
        if (words.length > 0) {
          const lines = fullText.split('\n');
          let charOffset = 0;
          for (const line of lines) {
            const lineLower = line.toLowerCase();
            const allWordsFound = words.every(word => lineLower.includes(word));
            if (allWordsFound && line.trim().length < 100) { // Short lines are likely headings
              startIndex = charOffset;
              console.log(`Strategy 5 (fuzzy): found at ${startIndex} in line: "${line.trim()}"`);
              break;
            }
            charOffset += line.length + 1; // +1 for newline
          }
        }
      }

      if (startIndex === -1) {
        console.log(`Could not find boundary for: "${normalizedTitle}"`);
        alert(`"${normalizedTitle}" 섹션을 텍스트에서 찾을 수 없습니다.\n제목을 정확히 입력해주세요.`);
        return;
      }

      // Update with startIndex only - endIndex will be recalculated based on note order
      setNotes(prev => {
        const updated = prev.map(n => 
          n.id === noteId 
            ? { 
                ...n, 
                sectionBoundary: { 
                  startIndex, 
                  endIndex: fullText.length, // Temporary, will be recalculated
                  sourceFile 
                } 
              } 
            : n
        );
        return updated;
      });
      
      console.log(`✅ Found startIndex for "${normalizedTitle}": ${startIndex}`);
      
      // Auto-recalculate boundaries after a short delay
      setTimeout(() => recalculateBoundaries(), 200);
    } catch (e) {
      console.error('Error finding boundary:', e);
    }
  }, [usedId, paperId, loadExtractedText]);

  // Recalculate endIndex for all notes based on their UI order (not sorted by startIndex)
  // Each note's endIndex = next note's startIndex in UI order
  const recalculateBoundaries = useCallback(async () => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    const textData = await loadExtractedText(id);
    const textLength = textData?.text.length || 100000;

    setNotes(prev => {
      // Use UI order directly - do NOT sort by startIndex
      // This allows users to manually arrange notes in any order they want
      return prev.map((note, index) => {
        if (!note.sectionBoundary) return note;

        // Find next note with boundary in UI order
        let nextNoteWithBoundary = null;
        for (let i = index + 1; i < prev.length; i++) {
          if (prev[i].sectionBoundary?.startIndex !== undefined) {
            nextNoteWithBoundary = prev[i];
            break;
          }
        }

        // endIndex = next note's startIndex in UI order, or text length if no next note
        const endIndex = nextNoteWithBoundary?.sectionBoundary?.startIndex || textLength;

        return {
          ...note,
          sectionBoundary: {
            ...note.sectionBoundary,
            endIndex
          }
        };
      });
    });
  }, [usedId, paperId, loadExtractedText]);

  // Drag and drop state
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);

  // Hover insert state
  const [hoveredInsertIndex, setHoveredInsertIndex] = useState<number | null>(null);

  // Add note at specific index
  const addNoteAt = useCallback((index: number) => {
    const newNote: NoteItem = {
      id: generateId(),
      title: '',
      pages: { manual: '' },
      activePage: 'manual',
      isOpen: true,
    };
    setNotes(prev => {
      const newNotes = [...prev];
      newNotes.splice(index, 0, newNote);
      return newNotes;
    });
    setHoveredInsertIndex(null);
  }, []);

  // Handle note drag start
  const handleNoteDragStart = useCallback((e: React.DragEvent, noteId: string) => {
    setDraggedNoteId(noteId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  // Handle drop - reorder notes
  const handleDrop = useCallback((e: React.DragEvent, targetNoteId: string) => {
    e.preventDefault();
    if (!draggedNoteId || draggedNoteId === targetNoteId) return;

    setNotes(prev => {
      const draggedIndex = prev.findIndex(n => n.id === draggedNoteId);
      const targetIndex = prev.findIndex(n => n.id === targetNoteId);
      if (draggedIndex === -1 || targetIndex === -1) return prev;

      const newNotes = [...prev];
      const [removed] = newNotes.splice(draggedIndex, 1);
      newNotes.splice(targetIndex, 0, removed);
      return newNotes;
    });

    setDraggedNoteId(null);
    
    // Recalculate boundaries after reorder
    setTimeout(() => recalculateBoundaries(), 100);
  }, [draggedNoteId, recalculateBoundaries]);

  const handleDragEnd = useCallback(() => {
    setDraggedNoteId(null);
  }, []);

  // Auto-find boundary when note title is edited (with debounce)
  const [pendingBoundarySearch, setPendingBoundarySearch] = useState<{noteId: string; title: string} | null>(null);
  
  useEffect(() => {
    if (!pendingBoundarySearch) return;
    
    const timer = setTimeout(() => {
      findBoundaryForNote(pendingBoundarySearch.noteId, pendingBoundarySearch.title);
      setPendingBoundarySearch(null);
    }, 1000); // 1 second debounce
    
    return () => clearTimeout(timer);
  }, [pendingBoundarySearch, findBoundaryForNote]);

  // Enhanced title update that triggers boundary search
  const updateNoteTitleWithBoundary = useCallback((noteId: string, title: string) => {
    updateNoteTitle(noteId, title);
    // Schedule boundary search (debounced)
    setPendingBoundarySearch({ noteId, title });
  }, [updateNoteTitle]);

  // Extract section headings using regex patterns with boundary information
  const extractHeadings = useCallback(async () => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    setExtracting(true);
    try {
      // 1. Load extracted text
      const textData = await loadExtractedText(id);
      if (!textData) {
        alert('텍스트 파일을 불러올 수 없습니다. PDF 텍스트 추출이 먼저 필요합니다.');
        return;
      }
      const { text: extractedText, sourceFile } = textData;

      // 2. Extract sections using multiple regex patterns
      interface SectionMatch {
        title: string;
        startIndex: number;
        matchLength: number;
      }

      const sections: SectionMatch[] = [];
      
      // Pattern 1: "N\nTitle" format (number on one line, title on next) - e.g., "1\nIntroduction"
      const pattern1 = /^(\d+(?:\.\d+)*)\s*\n([A-Z][A-Za-z\s\-:,]+?)(?=\n)/gm;
      let match;
      while ((match = pattern1.exec(extractedText)) !== null) {
        const numPart = match[1];
        // Validate section number format
        const parts = numPart.split('.');
        let isValidSectionNum = true;
        for (const part of parts) {
          const num = parseInt(part, 10);
          const maxAllowed = parts.indexOf(part) === 0 ? 20 : 50;
          if (isNaN(num) || num > maxAllowed || part.length > 2) {
            isValidSectionNum = false;
            break;
          }
        }
        if (!isValidSectionNum) {
          continue;
        }
        const title = `${match[1]} ${match[2].trim()}`;
        // Skip if title text is too short
        if (match[2].trim().length < 3) {
          continue;
        }
        // Skip if title is too long (likely not a heading)
        if (title.length <= 80) {
          sections.push({
            title,
            startIndex: match.index,
            matchLength: match[0].length
          });
        }
      }

      // Pattern 2: "N. Title" format (same line) - e.g., "1. Introduction"
      // Only match valid section numbers (not decimal values from tables)
      const pattern2 = /^(\d+(?:\.\d+)*)\.\s+([A-Z][A-Za-z\s\-:,]+?)(?=\n)/gm;
      while ((match = pattern2.exec(extractedText)) !== null) {
        const numPart = match[1];
        // Validate section number format: each part should be a reasonable integer (1-50)
        // Skip numbers like "14.76", "29.50", "66.7" which are likely table values
        const parts = numPart.split('.');
        let isValidSectionNum = true;
        for (const part of parts) {
          const num = parseInt(part, 10);
          // First part can be larger (up to 20 for main sections), subsections up to 50
          const maxAllowed = parts.indexOf(part) === 0 ? 20 : 50;
          if (isNaN(num) || num > maxAllowed || part.length > 2) {
            isValidSectionNum = false;
            break;
          }
        }
        if (!isValidSectionNum) {
          continue;
        }
        const title = `${match[1]}. ${match[2].trim()}`;
        // Skip if title is too short (less than 3 characters for the text part)
        if (match[2].trim().length < 3) {
          continue;
        }
        if (title.length <= 80) {
          // Check for duplicates (same position)
          const isDuplicate = sections.some(s => Math.abs(s.startIndex - match!.index) < 10);
          if (!isDuplicate) {
            sections.push({
              title,
              startIndex: match.index,
              matchLength: match[0].length
            });
          }
        }
      }

      // Pattern 3: Special sections without numbers
      const specialSections = ['Abstract', 'ABSTRACT', 'References', 'REFERENCES', 'Conclusion', 'CONCLUSION', 'Acknowledgement', 'Acknowledgements', 'ACKNOWLEDGEMENT', 'ACKNOWLEDGEMENTS'];
      for (const sectionName of specialSections) {
        const pattern = new RegExp(`^(${sectionName})\\s*(?:\\n|$)`, 'gm');
        while ((match = pattern.exec(extractedText)) !== null) {
          const title = match[1];
          const isDuplicate = sections.some(s => Math.abs(s.startIndex - match!.index) < 10);
          if (!isDuplicate) {
            sections.push({
              title,
              startIndex: match.index,
              matchLength: match[0].length
            });
          }
        }
      }

      // Pattern 4: "N.N Title" format (space separated, no trailing dot) - e.g., "2.1 Evaluated Environment"
      const pattern4 = /^(\d+\.\d+)\s+([A-Z][A-Za-z\s\-:,]+?)(?=\n)/gm;
      while ((match = pattern4.exec(extractedText)) !== null) {
        const numPart = match[1];
        const parts = numPart.split('.');
        
        // Validate: main section 1-15, subsection 1-10 (stricter to avoid table values like 7.36)
        const mainNum = parseInt(parts[0], 10);
        const subNum = parseInt(parts[1], 10);
        if (isNaN(mainNum) || isNaN(subNum) || mainNum > 15 || mainNum < 1 || subNum > 10 || subNum < 1) {
          continue;
        }
        
        const title = `${match[1]} ${match[2].trim()}`;
        if (match[2].trim().length >= 3 && title.length <= 80) {
          const isDuplicate = sections.some(s => Math.abs(s.startIndex - match!.index) < 10);
          if (!isDuplicate) {
            sections.push({
              title,
              startIndex: match.index,
              matchLength: match[0].length
            });
          }
        }
      }

      // Pattern 5: Appendix sections - e.g., "A. Details", "B Implementation"
      const pattern5 = /^([A-Z]\.?\d*\.?)\s+([A-Z][A-Za-z\s\-:,]+?)(?=\n)/gm;
      while ((match = pattern5.exec(extractedText)) !== null) {
        // Only match single letters (A, B, C...) not words
        if (match[1].length <= 3) {
          const title = `${match[1]} ${match[2].trim()}`;
          if (title.length <= 80) {
            const isDuplicate = sections.some(s => Math.abs(s.startIndex - match!.index) < 10);
            if (!isDuplicate) {
              sections.push({
                title,
                startIndex: match.index,
                matchLength: match[0].length
              });
            }
          }
        }
      }

      // 3. Sort sections by position and calculate end indices
      sections.sort((a, b) => a.startIndex - b.startIndex);

      // Remove duplicates: by position (within 50 chars) or by title
      const uniqueSections: SectionMatch[] = [];
      const seenTitles = new Set<string>();
      for (const section of sections) {
        const lastSection = uniqueSections[uniqueSections.length - 1];
        const normalizedTitle = section.title.toLowerCase().trim();
        // Skip if too close to previous or if we've seen this title before
        if (seenTitles.has(normalizedTitle)) {
          continue;
        }
        if (lastSection && section.startIndex - lastSection.startIndex <= 50) {
          continue;
        }
        uniqueSections.push(section);
        seenTitles.add(normalizedTitle);
      }

      if (uniqueSections.length === 0) {
        // Fallback to LLM if regex didn't find anything
        alert('정규식으로 목차를 찾을 수 없습니다. LLM 폴백을 시도합니다...');
        
        const prompt = `다음 논문 텍스트에서 소목차(section/subsection headings)를 추출해주세요.
규칙:
- 한 줄에 하나의 소목차만 출력
- 번호가 있으면 번호 포함 (예: "1. Introduction", "2.1 Background")
- 소목차 외의 설명이나 부연은 절대 추가하지 마세요
- 목차 제목만 순서대로 나열해주세요

논문 텍스트:
${extractedText.slice(0, 50000)}`;

        const chatRes = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: prompt, history: [] }),
        });

        if (chatRes.ok) {
          const chatData = await chatRes.json();
          const responseText = chatData.response || '';
          const headings = responseText
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0 && line.length < 100);

          if (headings.length > 0) {
            const newNotes: NoteItem[] = headings.map((title: string) => ({
              id: generateId(),
              title,
              pages: { manual: '' },
              activePage: 'manual' as NotePageType,
              isOpen: true,
            }));
            setNotes(newNotes);
            return;
          }
        }
        
        alert('목차를 추출할 수 없습니다.');
        return;
      }

      // 4. Create notes with boundary information
      const newNotes: NoteItem[] = uniqueSections.map((section, index) => {
        const nextSection = uniqueSections[index + 1];
        return {
          id: generateId(),
          title: section.title,
          pages: { manual: '' },
          activePage: 'manual' as NotePageType,
          isOpen: true,
          sectionBoundary: {
            startIndex: section.startIndex,
            endIndex: nextSection ? nextSection.startIndex : extractedText.length,
            sourceFile
          }
        };
      });

      setNotes(newNotes);
      console.log(`Extracted ${newNotes.length} sections with boundaries`);
      
      // Save extracted headings to file system
      try {
        const notesToSave = newNotes.map(n => ({
          id: n.id,
          title: n.title,
          pages: n.pages,
          activePage: n.activePage,
          isOpen: n.isOpen,
          sectionBoundary: n.sectionBoundary,
        }));
        
        const id = usedId || stripPrefixes(paperId);
        if (id) {
          const result = await executeTool('save_notes', {
            paper_id: id,
            notes: notesToSave,
          });
          if (result.success) {
            console.log('Notes saved to file system:', result.result?.saved_to);
          }
        }
      } catch (e) {
        console.error('Failed to save extracted headings:', e);
      }
    } catch (e) {
      alert(`소목차 추출 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExtracting(false);
    }
  }, [usedId, paperId, loadExtractedText]);

  // Translate a specific note's section using boundary indices (preferred) or title matching (fallback)
  const translateSection = useCallback(async (noteId: string, sectionTitle: string) => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    // 이미 번역 결과가 있으면 탭만 전환
    const note = notes.find(n => n.id === noteId);
    if (note?.pages.translation?.trim()) {
      setActivePage(noteId, 'translation');
      return;
    }

    setTranslatingNoteId(noteId);
    try {
      // Find the note and its boundary information
      const noteIndex = notes.findIndex(n => n.id === noteId);
      const noteData = notes[noteIndex];
      const nextSectionTitle = noteIndex >= 0 && noteIndex < notes.length - 1
        ? notes[noteIndex + 1].title
        : '';

      // Build request parameters
      const params: Record<string, unknown> = {
        paper_id: id,
        section_title: sectionTitle,
        next_section_title: nextSectionTitle,
        target_language: 'Korean',
      };

      // Add boundary indices if available (more reliable than title matching)
      if (noteData?.sectionBoundary) {
        params.start_index = noteData.sectionBoundary.startIndex;
        params.end_index = noteData.sectionBoundary.endIndex;
      }

      const result = await executeTool('translate_section', params);
      if (!result.success) {
        alert(`번역 실패: ${result.error || 'Unknown error'}`);
        return;
      }

      const translatedText = result.result?.translated_text || '';
      // translation 페이지에 저장하고 해당 탭으로 전환
      updateNotePage(noteId, 'translation', translatedText);
      setActivePage(noteId, 'translation');
    } catch (e) {
      alert(`번역 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranslatingNoteId(null);
    }
  }, [usedId, paperId, notes, updateNotePage, setActivePage]);

  // Analyze a specific note's section using page_analyzer
  const analyzeSection = useCallback(async (noteId: string, sectionTitle: string) => {
    const id = usedId || stripPrefixes(paperId);
    if (!id) return;

    // 이미 분석 결과가 있으면 탭만 전환
    const note = notes.find(n => n.id === noteId);
    if (note?.pages.analysis?.trim()) {
      setActivePage(noteId, 'analysis');
      return;
    }

    setAnalyzingNoteId(noteId);
    try {
      const noteIndex = notes.findIndex(n => n.id === noteId);
      const noteData = notes[noteIndex];
      const nextSectionTitle = noteIndex >= 0 && noteIndex < notes.length - 1
        ? notes[noteIndex + 1].title
        : '';

      // Build request parameters
      const params: Record<string, unknown> = {
        paper_id: id,
        section_title: sectionTitle,
        next_section_title: nextSectionTitle,
      };

      // Add boundary indices if available
      if (noteData?.sectionBoundary) {
        params.start_index = noteData.sectionBoundary.startIndex;
        params.end_index = noteData.sectionBoundary.endIndex;
      }

      const result = await executeTool('analyze_section', params);
      if (!result.success) {
        alert(`분석 실패: ${result.error || 'Unknown error'}`);
        return;
      }

      const analysisText = result.result?.analysis_text || '';
      // analysis 페이지에 저장하고 해당 탭으로 전환
      updateNotePage(noteId, 'analysis', analysisText);
      setActivePage(noteId, 'analysis');
    } catch (e) {
      alert(`분석 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAnalyzingNoteId(null);
    }
  }, [usedId, paperId, notes, updateNotePage, setActivePage]);

  // Execute prompt: send QA tab content to paper_qa tool (논문 특화 QA)
  // QA 탭의 내용을 질문으로 사용하고, 결과를 QA 탭에 누적
  const executePrompt = useCallback(async (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    const question = note?.pages.qa?.trim() || '';
    
    if (!question) {
      alert('QA 탭에 질문을 먼저 작성해주세요.');
      setActivePage(noteId, 'qa');
      return;
    }

    const id = usedId || stripPrefixes(paperId);
    if (!id) {
      alert('논문 ID를 찾을 수 없습니다.');
      return;
    }

    setPromptingNoteId(noteId);
    try {
      // 현재 섹션 컨텍스트 가져오기 (선택적)
      let sectionContext = '';
      if (note?.sectionBoundary) {
        const textData = await loadExtractedText(id);
        if (textData) {
          const { startIndex, endIndex } = note.sectionBoundary;
          sectionContext = textData.text.slice(startIndex, Math.min(endIndex, startIndex + 3000));
        }
      }

      // MCP paper_qa 도구 호출 (논문 특화 QA)
      const result = await executeTool('paper_qa', {
        paper_id: id,
        question: question,
        section_context: sectionContext,
      });

      if (!result.success) {
        alert(`QA 실패: ${result.error || 'Unknown error'}`);
        return;
      }

      const answer = result.result?.answer || '';
      if (!answer) {
        alert('응답이 비어 있습니다.');
        return;
      }

      // QA 탭에 결과 추가 (기존 질문 + 답변)
      const timestamp = new Date().toLocaleString('ko-KR');
      const qaResult = `${question}\n\n---\n\n**[${timestamp}] 답변:**\n\n${answer}`;
      
      updateNotePage(noteId, 'qa', qaResult);
    } catch (e) {
      alert(`프롬프트 실행 에러: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPromptingNoteId(null);
    }
  }, [usedId, paperId, notes, loadExtractedText, updateNotePage, setActivePage]);

  const notionNotesPayload = useMemo(
    () => notes.map(n => ({
      title: n.title || '(Untitled note)',
      memo: (n.pages.manual || '').trim(),
      translation: (n.pages.translation || '').trim(),
      analysis: (n.pages.analysis || '').trim(),
      qa: (n.pages.qa || '').trim(),
    })),
    [notes]
  );

  // Save all notes to Notion
  
// Save all notes to Notion (multi-note toggle tree)
const handleSaveToNotion = useCallback(() => {
  const id = usedId || stripPrefixes(paperId);
  if (!id) {
    alert('논문 ID를 찾을 수 없습니다.');
    return;
  }

  if (notes.length === 0) {
    alert('저장할 노트가 없습니다.');
    return;
  }

  setIsNotionSaveModalOpen(true);
}, [usedId, paperId, notes.length]);

const handleNotionSaved = useCallback((result: SaveNotionNotesResult) => {
  const pageUrl = result.page_url || '';
  const pageTitle = result.page_title || '';
  alert(`Notion에 저장되었습니다.\n\n페이지: ${pageTitle}\nURL: ${pageUrl}`);
  if (pageUrl && confirm('Notion 페이지를 열까요?')) {
    window.open(pageUrl, '_blank');
  }
}, []);
const handleOpenAccountSettings = useCallback(() => {
  setIsNotionSaveModalOpen(false);
  props.onOpenAccountSettings?.();
}, [props.onOpenAccountSettings]);
/*
    // Build `notes` payload expected by MCP save_to_notion tool.
    // Each UI note becomes a top-level toggle; each tab becomes a sub-toggle.
    const notionNotes = notes.map(n => ({
      title: n.title || '(제목 없음)',
      memo: (n.pages.manual || '').trim(),
      translation: (n.pages.translation || '').trim(),
      analysis: (n.pages.analysis || '').trim(),
      // In UI this is "qa" tab but label is Prompt; backend supports prompt/qa
      qa: (n.pages.qa || '').trim(),
    }));

    // Use executeTool directly so the payload is not altered by wrappers.
    const result = await executeTool('save_to_notion', {
      paper_id: id,
      paper_title: id, // if you later have real title metadata, replace here
      notes: notionNotes,
      updated_at: new Date().toISOString(),
    });

    if (result.success) {
      const pageUrl = result.page_url || result.result?.page_url;
      const pageTitle = result.page_title || result.result?.page_title;
      alert(`Notion에 저장되었습니다!\n\n페이지: ${pageTitle || ''}\nURL: ${pageUrl || ''}`);

      if (pageUrl && confirm('Notion 페이지를 열까요?')) {
        window.open(pageUrl, '_blank');
      }
    } else {
      alert(`Notion 저장 실패: ${result.error || 'Unknown error'}`);
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    alert(`Notion 저장 실패: ${errorMessage}`);
  } finally {
    setSavingToNotion(false);
  }
}, [usedId, paperId, notes]);

*/

  return (
    <div ref={containerRef} style={{ display: 'flex', height: '100vh', backgroundColor: '#f5f5f5' }}>
      <style>{`
        .markdown-preview h1 { font-size: 1.4em; font-weight: 700; margin: 0.6em 0 0.3em; color: #1a202c; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.2em; }
        .markdown-preview h2 { font-size: 1.2em; font-weight: 700; margin: 0.5em 0 0.3em; color: #2d3748; }
        .markdown-preview h3 { font-size: 1.1em; font-weight: 600; margin: 0.4em 0 0.2em; color: #2d3748; }
        .markdown-preview h4, .markdown-preview h5, .markdown-preview h6 { font-size: 1em; font-weight: 600; margin: 0.3em 0 0.2em; color: #4a5568; }
        .markdown-preview p { margin: 0.4em 0; }
        .markdown-preview strong { font-weight: 700; }
        .markdown-preview em { font-style: italic; }
        .markdown-preview code { background: #edf2f7; padding: 2px 5px; border-radius: 3px; font-family: 'Courier New', monospace; font-size: 0.9em; color: #d53f8c; }
        .markdown-preview pre { background: #2d3748; color: #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 0.5em 0; }
        .markdown-preview pre code { background: none; color: inherit; padding: 0; font-size: 0.85em; }
        .markdown-preview ul, .markdown-preview ol { margin: 0.4em 0; padding-left: 1.5em; }
        .markdown-preview li { margin: 0.2em 0; }
        .markdown-preview blockquote { border-left: 3px solid #cbd5e0; margin: 0.5em 0; padding: 0.3em 0.8em; color: #4a5568; background: #f7fafc; border-radius: 0 4px 4px 0; }
        .markdown-preview hr { border: none; border-top: 1px solid #e2e8f0; margin: 0.8em 0; }
        .markdown-preview a { color: #3182ce; text-decoration: underline; }
        .markdown-preview table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
        .markdown-preview th, .markdown-preview td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; font-size: 0.9em; }
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

          {!loading && !error && !pdfUrl && (
            <div style={{ color: '#718096', fontSize: 14 }}>
              PDF 페이지를 찾을 수 없습니다. (/output/{'{paperId}'}/paper.pdf 또는 /pdf/{'{paperId}'}.pdf 확인)
            </div>
          )}

          {!loading && !error && pdfUrl && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 700, margin: '0 0 10px', color: '#2d3748' }}>Embedded PDF</div>
              <iframe
                src={pdfUrl}
                title={`paper-${usedId || paperId}`}
                style={{
                  width: '100%',
                  minHeight: '72vh',
                  borderRadius: 8,
                  border: '1px solid #edf2f7',
                  background: '#fff'
                }}
              />
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
              onClick={handleSaveToNotion}
              disabled={notes.length === 0}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                border: '1px solid #e2e8f0',
                backgroundColor: notes.length === 0 ? '#edf2f7' : '#faf5ff',
                color: notes.length === 0 ? '#a0aec0' : '#6b46c1',
                cursor: notes.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
              title="현재 노트를 Notion에 저장합니다"
            >
              Notion에 저장
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

          {notes.map((note, noteIndex) => (
            <React.Fragment key={note.id}>
              {/* Hover insert zone before each note */}
              <div
                onMouseEnter={() => setHoveredInsertIndex(noteIndex)}
                onMouseLeave={() => setHoveredInsertIndex(null)}
                onClick={() => addNoteAt(noteIndex)}
                style={{
                  height: hoveredInsertIndex === noteIndex ? 40 : 16,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  cursor: 'pointer',
                  backgroundColor: hoveredInsertIndex === noteIndex ? '#f0f9ff' : 'transparent',
                  borderRadius: 8,
                  margin: '4px 0',
                }}
              >
                {hoveredInsertIndex === noteIndex ? (
                  <div
                    style={{
                      padding: '4px 24px',
                      borderRadius: 12,
                      border: '2px dashed #4299e1',
                      backgroundColor: '#ebf8ff',
                      color: '#3182ce',
                      fontSize: 16,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span>+</span>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>노트 추가</span>
                  </div>
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: 2,
                      backgroundColor: '#e2e8f0',
                      borderRadius: 1,
                      margin: '0 12px',
                    }}
                  />
                )}
              </div>

              <div
                draggable
                onDragStart={(e) => handleNoteDragStart(e, note.id)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, note.id)}
                onDragEnd={handleDragEnd}
                style={{
                  backgroundColor: '#fff',
                  border: draggedNoteId === note.id ? '2px dashed #4299e1' : '1px solid #e2e8f0',
                  borderRadius: 10,
                  overflow: 'hidden',
                  flexShrink: 0,
                  opacity: draggedNoteId === note.id ? 0.5 : 1,
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
                {/* Drag handle */}
                <span
                  style={{
                    cursor: 'grab',
                    color: '#a0aec0',
                    fontSize: 14,
                    userSelect: 'none',
                    flexShrink: 0,
                  }}
                  title="드래그하여 순서 변경"
                >
                  ⋮⋮
                </span>

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
                  onChange={(e) => updateNoteTitleWithBoundary(note.id, e.target.value)}
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

                {/* Boundary indicator and search button */}
                <button
                  onClick={() => {
                    if (note.sectionBoundary) {
                      // Reset boundary when clicking ✓
                      setNotes(prev => prev.map(n => 
                        n.id === note.id ? { ...n, sectionBoundary: undefined } : n
                      ));
                    } else {
                      // Find boundary when clicking 🔍
                      findBoundaryForNote(note.id, note.title);
                    }
                  }}
                  disabled={!note.title.trim()}
                  style={{
                    padding: '2px 6px',
                    borderRadius: 4,
                    border: 'none',
                    backgroundColor: note.sectionBoundary ? '#c6f6d5' : '#fed7d7',
                    color: note.sectionBoundary ? '#22543d' : '#c53030',
                    cursor: note.title.trim() ? 'pointer' : 'not-allowed',
                    fontSize: 10,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title={note.sectionBoundary 
                    ? `✅ 위치 계산 완료 (${note.sectionBoundary.startIndex}~${note.sectionBoundary.endIndex}자)\n클릭하여 초기화` 
                    : '🔍 클릭하여 섹션 위치 검색'}
                >
                  {note.sectionBoundary ? '✓' : '🔍'}
                </button>

                {/* Prompt button */}
                <button
                  onClick={() => executePrompt(note.id)}
                  disabled={promptingNoteId === note.id || !note.pages.qa?.trim()}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: promptingNoteId === note.id ? '#edf2f7' : '#c6f6d5',
                    color: promptingNoteId === note.id ? '#a0aec0' : '#22543d',
                    cursor: promptingNoteId === note.id ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title="QA 탭의 내용을 질문으로 LLM에 전송하고 답변을 추가합니다"
                >
                  {promptingNoteId === note.id ? '처리 중...' : 'Prompt'}
                </button>

                {/* Analysis button */}
                <button
                  onClick={() => analyzeSection(note.id, note.title)}
                  disabled={analyzingNoteId === note.id || !note.title.trim()}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: analyzingNoteId === note.id ? '#edf2f7' : note.pages.analysis?.trim() ? '#d6bcfa' : '#e9d8fd',
                    color: analyzingNoteId === note.id ? '#a0aec0' : '#553c9a',
                    cursor: analyzingNoteId === note.id ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title={note.pages.analysis?.trim() ? '분석 결과 보기 (클릭하여 탭 전환)' : '이 섹션을 분석하여 해설합니다'}
                >
                  {analyzingNoteId === note.id ? '분석 중...' : note.pages.analysis?.trim() ? 'Analysis ✓' : 'Analysis'}
                </button>

                {/* Translate button */}
                <button
                  onClick={() => translateSection(note.id, note.title)}
                  disabled={translatingNoteId === note.id || !note.title.trim()}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: translatingNoteId === note.id ? '#edf2f7' : note.pages.translation?.trim() ? '#f6e05e' : '#fefcbf',
                    color: translatingNoteId === note.id ? '#a0aec0' : '#975a16',
                    cursor: translatingNoteId === note.id ? 'not-allowed' : 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title={note.pages.translation?.trim() ? '번역 결과 보기 (클릭하여 탭 전환)' : '이 섹션을 한국어로 번역합니다'}
                >
                  {translatingNoteId === note.id ? '번역 중...' : note.pages.translation?.trim() ? 'Translate ✓' : 'Translate'}
                </button>

                {/* Edit/Preview toggle button */}
                <button
                  onClick={() => toggleEditMode(note.id)}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    backgroundColor: editingNoteIds.has(note.id) ? '#fed7e2' : '#e2e8f0',
                    color: editingNoteIds.has(note.id) ? '#97266d' : '#4a5568',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  title={editingNoteIds.has(note.id) ? '미리보기 모드로 전환' : '편집 모드로 전환'}
                >
                  {editingNoteIds.has(note.id) ? 'Preview' : 'Edit'}
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
                  {/* 탭 네비게이션 */}
                  <div style={{ 
                    display: 'flex', 
                    gap: 2, 
                    marginBottom: 10, 
                    borderBottom: '1px solid #e2e8f0',
                    paddingBottom: 6,
                  }}>
                    {(['manual', 'translation', 'analysis', 'qa'] as const).map(tab => {
                      const hasContent = tab === 'manual' 
                        ? !!note.pages.manual?.trim()
                        : !!note.pages[tab]?.trim();
                      const isActive = note.activePage === tab;
                      const tabLabels = {
                        manual: '📝 메모',
                        translation: '🌐 번역',
                        analysis: '🔬 분석',
                        qa: '💬 Prompt',
                      };
                      return (
                        <button
                          key={tab}
                          onClick={() => setActivePage(note.id, tab)}
                          style={{
                            padding: '5px 10px',
                            border: 'none',
                            borderBottom: isActive ? '2px solid #3182ce' : '2px solid transparent',
                            background: 'transparent',
                            color: isActive ? '#3182ce' : '#718096',
                            fontWeight: isActive ? 600 : 400,
                            cursor: 'pointer',
                            fontSize: 12,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          {tabLabels[tab]}
                          {hasContent && !isActive && (
                            <span style={{ 
                              width: 6, 
                              height: 6, 
                              borderRadius: '50%', 
                              backgroundColor: '#48bb78',
                            }} />
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* 현재 탭 내용 */}
                  {(() => {
                    const currentContent = note.pages[note.activePage] || '';
                    const tabPlaceholders: Record<NotePageType, string> = {
                      manual: '메모를 작성하세요...',
                      translation: '번역 결과가 표시됩니다. "Translate" 버튼을 클릭하거나 직접 작성하세요...',
                      analysis: '분석 결과가 표시됩니다. "Analysis" 버튼을 클릭하거나 직접 작성하세요...',
                      qa: '질문을 작성한 후 "Prompt" 버튼을 클릭하세요...',
                    };
                    
                    // 편집 모드: 모든 탭에서 편집 가능
                    if (editingNoteIds.has(note.id)) {
                      return (
                        <div style={{ display: 'flex', gap: 10, minHeight: 150 }}>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                            <div style={{ fontSize: 10, color: '#718096', marginBottom: 4, fontWeight: 600 }}>
                              편집 (마크다운)
                            </div>
                            <textarea
                              value={currentContent}
                              onChange={(e) => updateNotePage(note.id, note.activePage, e.target.value)}
                              placeholder={tabPlaceholders[note.activePage]}
                              style={{
                                flex: 1,
                                width: '100%',
                                minHeight: 120,
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
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                            <div style={{ fontSize: 10, color: '#718096', marginBottom: 4, fontWeight: 600 }}>
                              실시간 미리보기
                            </div>
                            <div
                              style={{
                                flex: 1,
                                borderRadius: 6,
                                border: '1px solid #e2e8f0',
                                padding: 10,
                                fontSize: 13,
                                lineHeight: 1.6,
                                backgroundColor: '#fafafa',
                                overflowY: 'auto',
                                minHeight: 120,
                              }}
                            >
                              {currentContent.trim() ? (
                                <div className="markdown-preview">
                                  <ReactMarkdown>{currentContent}</ReactMarkdown>
                                </div>
                              ) : (
                                <div style={{ color: '#a0aec0', fontStyle: 'italic' }}>
                                  미리보기가 여기에 표시됩니다...
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    // 미리보기 모드: 클릭하면 편집 모드로 전환
                    return (
                      <div
                        onClick={() => toggleEditMode(note.id)}
                        style={{
                          minHeight: 60,
                          borderRadius: 6,
                          border: '1px solid #e2e8f0',
                          padding: 10,
                          fontSize: 13,
                          lineHeight: 1.6,
                          cursor: 'pointer',
                          backgroundColor: '#fafafa',
                        }}
                        title="클릭하여 편집"
                      >
                        {currentContent.trim() ? (
                          <div className="markdown-preview">
                            <ReactMarkdown>{currentContent}</ReactMarkdown>
                          </div>
                        ) : (
                          <div style={{ color: '#a0aec0', fontStyle: 'italic' }}>
                            {tabPlaceholders[note.activePage]}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
            </React.Fragment>
          ))}

          {/* Hover insert zone after last note / Add note button */}
          <div
            onMouseEnter={() => setHoveredInsertIndex(notes.length)}
            onMouseLeave={() => setHoveredInsertIndex(null)}
            onClick={() => addNoteAt(notes.length)}
            style={{
              height: hoveredInsertIndex === notes.length ? 48 : 40,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease',
              cursor: 'pointer',
              backgroundColor: hoveredInsertIndex === notes.length ? '#f0f9ff' : 'transparent',
              borderRadius: 8,
              margin: '8px 0',
              border: hoveredInsertIndex === notes.length ? '2px dashed #4299e1' : '2px dashed #e2e8f0',
            }}
          >
            <div
              style={{
                color: hoveredInsertIndex === notes.length ? '#3182ce' : '#a0aec0',
                fontSize: 14,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 18 }}>+</span>
              <span>노트 추가</span>
            </div>
          </div>
        </div>
      </div>
      <NotionSaveModal
        isOpen={isNotionSaveModalOpen}
        paperId={usedId || stripPrefixes(paperId)}
        paperTitle={usedId || stripPrefixes(paperId)}
        notes={notionNotesPayload}
        onClose={() => setIsNotionSaveModalOpen(false)}
        onOpenAccountSettings={handleOpenAccountSettings}
        onSaved={handleNotionSaved}
      />
    </div>
  );
}
