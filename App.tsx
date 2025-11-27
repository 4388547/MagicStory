
import React, { useState, useEffect, useRef } from 'react';
import { BookOpen, Search, Loader2, Play, Pause, Download, Volume2, ImageIcon, Video, Edit2, ArrowRight, ChevronRight, RefreshCw, CheckCircle2, Plus, Trash2, FileVideo, Film, Monitor, Smartphone, Settings, Lock } from './components/Icons';
import { generateStoryFromBook, generateReferenceImage, generateVeoVideo, generateSceneAudio } from './services/geminiService';
import { AppState, Scene, StoryMetadata, SubtitleLine, VideoSettings } from './types';

const INITIAL_STATE: AppState = {
  step: 'input',
  bookName: '',
  storyMetadata: null,
  scenes: [],
  referenceImageUrl: null,
  logs: [],
  videoSettings: {
    resolution: '720p',
    aspectRatio: '16:9'
  }
};

const DEFAULT_BOOKS = [
  "The Very Hungry Caterpillar",
  "Where the Wild Things Are",
  "The Cat in the Hat",
  "Goodnight Moon",
  "The Little Prince",
  "Corduroy"
];

const STEPS = [
  { id: 'input', label: 'Book Search', icon: Search },
  { id: 'story-gen', label: 'Story & Style', icon: BookOpen },
  { id: 'ref-image-gen', label: 'Character Ref', icon: ImageIcon },
  { id: 'video-gen', label: 'Video Production', icon: Video },
  { id: 'finished', label: 'Final Movie', icon: Play },
];

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [loading, setLoading] = useState(false);
  const [activeSceneIndex, setActiveSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Audio Time Tracking for Subtitles
  const [audioTime, setAudioTime] = useState(0);
  const [currentSubtitle, setCurrentSubtitle] = useState<SubtitleLine | null>(null);

  // Rendering State
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // --- Helpers ---
  const addLog = (msg: string) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, `[${new Date().toLocaleTimeString()}] ${msg}`] }));
  };

  const checkApiKey = async () => {
    const win = window as any;
    if (win.aistudio) {
      const hasKey = await win.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        try {
            await win.aistudio.openSelectKey();
        } catch(e) {
            console.error("Key selection failed", e);
        }
      }
    }
  };

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [state.logs]);

  // --- State Updaters & Invalidation Logic ---

  // Update Metadata (Style/Character). Note: This invalidates the Reference Image.
  const updateMetadata = (field: keyof StoryMetadata, value: string) => {
    setState(prev => {
      if (!prev.storyMetadata) return prev;
      
      const isCriticalChange = field === 'visualStyle' || field === 'characterDescription';
      
      return {
        ...prev,
        storyMetadata: { ...prev.storyMetadata, [field]: value },
        // If critical style changes, we must reset the reference image
        referenceImageUrl: isCriticalChange ? null : prev.referenceImageUrl,
        // If we lost the ref image, we can't be in video-gen steps safely without regenerating it
        step: isCriticalChange && (prev.step === 'video-gen' || prev.step === 'finished') ? 'story-gen' : prev.step
      };
    });
  };

  // Update Scene. Note: This invalidates the specific scene's assets.
  const updateScene = (index: number, field: keyof Scene, value: string) => {
    setState(prev => {
      const newScenes = [...prev.scenes];
      const oldScene = newScenes[index];
      
      // If content changed, reset status to pending so it gets regenerated
      const hasChanged = oldScene[field] !== value;
      
      newScenes[index] = {
        ...oldScene,
        [field]: value,
        status: hasChanged ? 'pending' : oldScene.status,
        videoUrl: hasChanged ? undefined : oldScene.videoUrl,
        audioUrl: hasChanged ? undefined : oldScene.audioUrl,
        subtitles: hasChanged ? undefined : oldScene.subtitles
      };

      return { ...prev, scenes: newScenes };
    });
  };

  const addScene = () => {
    setState(prev => {
      const newId = prev.scenes.length + 1;
      const newScene: Scene = {
        id: newId,
        textEn: "",
        textZh: "",
        visualPrompt: "A scene describing...",
        voiceMood: "calm",
        status: 'pending'
      };
      return { ...prev, scenes: [...prev.scenes, newScene] };
    });
  };

  const deleteScene = (indexToDelete: number) => {
    setState(prev => {
      // Remove scene and re-index IDs to keep them sequential (1, 2, 3...)
      const newScenes = prev.scenes
        .filter((_, idx) => idx !== indexToDelete)
        .map((scene, idx) => ({
          ...scene,
          id: idx + 1
        }));
      
      // If we deleted the active scene in playback mode, reset active index
      if (activeSceneIndex >= newScenes.length) {
          setActiveSceneIndex(Math.max(0, newScenes.length - 1));
      }

      return { ...prev, scenes: newScenes };
    });
  };

  const updateVideoSettings = (field: keyof VideoSettings, value: string) => {
     setState(prev => ({
         ...prev,
         videoSettings: { ...prev.videoSettings, [field]: value },
         // Changing settings invalidates current videos
         scenes: prev.scenes.map(s => ({ 
             ...s, 
             status: s.status === 'completed' || s.status === 'error' ? 'pending' : s.status,
             videoUrl: undefined
         })),
         // Also might want to invalidate ref image if we want it to match aspect ratio, but let's keep it simple for now or invalidate if it was generated
         referenceImageUrl: null, 
         step: prev.step === 'finished' || prev.step === 'video-gen' || prev.step === 'ref-image-gen' ? 'story-gen' : prev.step
     }));
  };

  const jumpToStep = (targetStep: AppState['step']) => {
    if (loading || isRendering) return;
    
    // Logic to prevent jumping ahead if data isn't ready
    const stepOrder = ['input', 'story-gen', 'ref-image-gen', 'video-gen', 'finished'];
    const currentIdx = stepOrder.indexOf(state.step);
    const targetIdx = stepOrder.indexOf(targetStep);

    // Can always go back
    if (targetIdx < currentIdx) {
      setState(prev => ({ ...prev, step: targetStep }));
      return;
    }

    // Can only go forward if prerequisites are met
    if (targetStep === 'story-gen' && !state.storyMetadata) return;
    if (targetStep === 'ref-image-gen' && !state.storyMetadata) return;
    if (targetStep === 'video-gen' && !state.referenceImageUrl) return;

    setState(prev => ({ ...prev, step: targetStep }));
  };

  // --- Async Handlers ---

  const handleGenerateStory = async () => {
    let query = state.bookName.trim();
    if (!query) {
      const randomBook = DEFAULT_BOOKS[Math.floor(Math.random() * DEFAULT_BOOKS.length)];
      query = randomBook;
      setState(prev => ({ ...prev, bookName: randomBook }));
    }

    setLoading(true);
    addLog(`Searching and adapting "${query}"...`);
    
    try {
      const { metadata, scenes } = await generateStoryFromBook(query);
      setState(prev => ({
        ...prev,
        storyMetadata: metadata,
        scenes,
        step: 'story-gen',
        referenceImageUrl: null // New story means new reference needed
      }));
      addLog("Story adapted successfully.");
    } catch (err) {
      addLog(`Error generating story: ${err}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateReference = async () => {
    if (!state.storyMetadata) return;
    await checkApiKey();
    setLoading(true);
    addLog("Generating consistent character reference sheet...");
    try {
      const url = await generateReferenceImage(state.storyMetadata, state.videoSettings);
      setState(prev => ({ ...prev, referenceImageUrl: url, step: 'ref-image-gen' }));
      addLog("Reference image generated.");
    } catch (err) {
      addLog(`Error generating reference image: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const regenerateScene = async (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    if (!state.referenceImageUrl) {
        addLog("Cannot regenerate: Missing reference image.");
        return;
    }
    
    await checkApiKey();

    const scene = state.scenes[index];
    
    // Update status to generating
    setState(prev => {
        const newScenes = [...prev.scenes];
        newScenes[index] = { ...scene, status: 'generating' };
        return { ...prev, scenes: newScenes };
    });
    addLog(`Regenerating Scene ${scene.id}...`);

    try {
        const [videoUrl, audioData] = await Promise.all([
          generateVeoVideo(scene, state.referenceImageUrl, state.videoSettings),
          generateSceneAudio(scene.textEn, scene.textZh, scene.voiceMood)
        ]);

        setState(prev => {
            const newScenes = [...prev.scenes];
            newScenes[index] = { 
                ...newScenes[index], 
                status: 'completed', 
                videoUrl, 
                audioUrl: audioData.url,
                audioDuration: audioData.duration,
                subtitles: audioData.subtitles
            };
            return { ...prev, scenes: newScenes };
        });
        addLog(`Scene ${scene.id} regenerated.`);
        
        // If this was the active scene, auto-play
        if (activeSceneIndex === index) {
            setIsPlaying(true);
        }

    } catch (err) {
        addLog(`Error regenerating Scene ${scene.id}: ${err}`);
        setState(prev => {
            const newScenes = [...prev.scenes];
            newScenes[index] = { ...newScenes[index], status: 'error' };
            return { ...prev, scenes: newScenes };
        });
    }
  };

  const handleGenerateAssets = async () => {
    if (!state.referenceImageUrl) return;
    await checkApiKey();

    setState(prev => ({ ...prev, step: 'video-gen' }));
    
    const newScenes = [...state.scenes];
    let hasUpdates = false;
    
    for (let i = 0; i < newScenes.length; i++) {
      const scene = newScenes[i];
      // Only generate if pending or error (skips already completed scenes unless edited)
      if (scene.status === 'completed') continue;

      hasUpdates = true;
      addLog(`Processing Scene ${scene.id}...`);
      newScenes[i] = { ...scene, status: 'generating' };
      setState(prev => ({ ...prev, scenes: [...newScenes] }));

      try {
        const [videoUrl, audioData] = await Promise.all([
          generateVeoVideo(scene, state.referenceImageUrl!, state.videoSettings),
          generateSceneAudio(scene.textEn, scene.textZh, scene.voiceMood)
        ]);

        newScenes[i] = { 
          ...scene, 
          status: 'completed', 
          videoUrl, 
          audioUrl: audioData.url,
          audioDuration: audioData.duration,
          subtitles: audioData.subtitles
        };
        addLog(`Scene ${scene.id} completed.`);
      } catch (err) {
        addLog(`Error on Scene ${scene.id}: ${err}`);
        newScenes[i] = { ...scene, status: 'error' };
      }
      setState(prev => ({ ...prev, scenes: [...newScenes] }));
    }

    if (!hasUpdates) {
       addLog("All scenes are already up to date.");
    }

    setState(prev => ({ ...prev, step: 'finished' }));
  };

  // --- Rendering / Merging Logic ---

  const handleExportMovie = async () => {
    setIsRendering(true);
    setRenderProgress(0);
    setIsPlaying(false);

    try {
      const canvas = document.createElement('canvas');
      
      // Determine canvas size based on settings.
      // Note: If Ref Image is present, videos are actually 720p 16:9 regardless of settings due to API limits.
      // We will respect the generated video size.
      const width = 1280; // Defaulting to 720p 16:9 for consistency-based videos
      const height = 720;

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not get canvas context");

      // Audio Context for mixing
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      
      const stream = canvas.captureStream(30); // 30 FPS
      
      // Add audio track
      const audioTrack = dest.stream.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);

      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
      });

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.start();

      // Play through scenes
      for (let i = 0; i < state.scenes.length; i++) {
        const scene = state.scenes[i];
        if (scene.status !== 'completed' || !scene.videoUrl || !scene.audioUrl) continue;
        
        setRenderProgress(Math.round((i / state.scenes.length) * 100));

        await new Promise<void>((resolve, reject) => {
          const vid = document.createElement('video');
          vid.src = scene.videoUrl!;
          vid.crossOrigin = "anonymous";
          vid.muted = true; // We play audio separately
          
          const aud = new Audio(scene.audioUrl!);
          aud.crossOrigin = "anonymous";
          
          // Connect audio to destination
          const source = audioCtx.createMediaElementSource(aud);
          source.connect(dest);

          let drawInterval: number;

          const drawFrame = () => {
            // Draw Video
            // Calculate scale to fit video into canvas while maintaining aspect ratio (cover)
            const hRatio = canvas.width / vid.videoWidth;
            const vRatio = canvas.height / vid.videoHeight;
            const ratio = Math.max(hRatio, vRatio);
            const centerShift_x = (canvas.width - vid.videoWidth * ratio) / 2;
            const centerShift_y = (canvas.height - vid.videoHeight * ratio) / 2;
            
            ctx.drawImage(vid, 0, 0, vid.videoWidth, vid.videoHeight,
                          centerShift_x, centerShift_y, vid.videoWidth * ratio, vid.videoHeight * ratio);
            
            // Draw Subtitles
            const t = aud.currentTime;
            const sub = scene.subtitles?.find(s => t >= s.startTime && t < s.endTime);
            
            if (sub) {
              // Style
              ctx.textAlign = 'center';
              ctx.shadowColor = "black";
              ctx.shadowBlur = 4;
              ctx.shadowOffsetX = 2;
              ctx.shadowOffsetY = 2;

              // Adjust font size based on resolution
              const scaleFactor = canvas.height / 720;
              const enSize = Math.round(24 * scaleFactor);
              const zhSize = Math.round(20 * scaleFactor);
              const bottomMargin = Math.round(80 * scaleFactor);
              const lineGap = Math.round(40 * scaleFactor);

              // English
              ctx.font = `bold ${enSize}px Nunito, sans-serif`;
              ctx.fillStyle = 'white';
              ctx.fillText(sub.textEn, canvas.width / 2, canvas.height - bottomMargin);

              // Chinese
              ctx.font = `bold ${zhSize}px "Noto Sans SC", sans-serif`;
              ctx.fillStyle = '#fde047'; // Yellow-300
              ctx.fillText(sub.textZh, canvas.width / 2, canvas.height - (bottomMargin - lineGap));
            }
          };

          vid.oncanplay = () => {
            vid.play();
            aud.play();
            drawInterval = window.setInterval(drawFrame, 1000/30);
          };

          aud.onended = () => {
            window.clearInterval(drawInterval);
            source.disconnect();
            resolve();
          };

          vid.onerror = (e) => reject(e);
          aud.onerror = (e) => reject(e);
        });
      }

      recorder.stop();
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.storyMetadata?.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'story'}_full_movie.webm`;
        a.click();
        
        setIsRendering(false);
        setRenderProgress(0);
        audioCtx.close();
      };

    } catch (e) {
      console.error("Export failed", e);
      addLog("Export failed: " + e);
      setIsRendering(false);
    }
  };

  // --- Playback Logic ---
  useEffect(() => {
    if (!videoRef.current || !audioRef.current) return;
    if (isPlaying) {
      videoRef.current.play().catch(e => console.error("Video play error", e));
      audioRef.current.play().catch(e => console.error("Audio play error", e));
    } else {
      videoRef.current.pause();
      audioRef.current.pause();
    }
  }, [isPlaying, activeSceneIndex]);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
        const t = audioRef.current.currentTime;
        setAudioTime(t);
        
        // Find current subtitle line
        const scene = state.scenes[activeSceneIndex];
        if (scene && scene.subtitles) {
            const currentLine = scene.subtitles.find(line => t >= line.startTime && t < line.endTime);
            setCurrentSubtitle(currentLine || null);
        } else {
            // Fallback if no specific timestamps generated
            setCurrentSubtitle({
                textEn: scene.textEn,
                textZh: scene.textZh,
                startTime: 0,
                endTime: scene.audioDuration || 100
            });
        }
    }
  };

  const handleSceneEnd = () => {
    setIsPlaying(false);
    setAudioTime(0);
    setCurrentSubtitle(null);
  };

  // --- Render Sections ---

  const renderProgressBar = () => {
    const stepOrder = ['input', 'story-gen', 'ref-image-gen', 'video-gen', 'finished'];
    const currentIdx = stepOrder.indexOf(state.step);

    return (
      <div className="flex flex-col md:flex-row justify-between items-center mb-10 px-4 max-w-6xl mx-auto gap-4">
        {STEPS.map((s, idx) => {
          const isActive = idx === currentIdx;
          const isPast = idx < currentIdx;
          const isFuture = idx > currentIdx;
          const canClick = idx < currentIdx || (idx === currentIdx + 1 && ((idx === 1 && state.scenes.length > 0) || (idx === 2 && state.storyMetadata) || (idx === 3 && state.referenceImageUrl)));

          return (
            <React.Fragment key={s.id}>
              {idx > 0 && (
                <div className={`hidden md:block h-0.5 flex-grow mx-2 ${isPast ? 'bg-indigo-500' : 'bg-slate-700'}`}></div>
              )}
              {idx > 0 && (
                <div className="md:hidden">
                    <ChevronRight className="w-4 h-4 text-slate-600" />
                </div>
              )}
              
              <button 
                onClick={() => canClick ? jumpToStep(s.id as AppState['step']) : null}
                disabled={!canClick || isRendering}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-full border-2 transition-all
                  ${isActive 
                    ? 'bg-indigo-900/50 border-indigo-500 text-indigo-300 shadow-lg shadow-indigo-500/20 scale-105' 
                    : isPast 
                      ? 'bg-slate-800 border-indigo-500/50 text-indigo-400 hover:bg-slate-700' 
                      : 'bg-slate-900 border-slate-700 text-slate-600 opacity-60 cursor-not-allowed'}
                `}
              >
                <s.icon className="w-4 h-4" />
                <span className="font-bold text-sm whitespace-nowrap">{s.label}</span>
                {isPast && <CheckCircle2 className="w-3 h-3 ml-1 text-green-500" />}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 flex flex-col font-sans">
      <header className="mb-8 text-center">
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400 mb-2 flex items-center justify-center gap-3">
          <BookOpen className="w-10 h-10 text-indigo-400" />
          MagicStory
        </h1>
        <p className="text-slate-400">Bring children's books to life with AI Video & Voice</p>
      </header>

      {renderProgressBar()}

      <main className="flex-grow max-w-6xl mx-auto w-full space-y-8 pb-20 relative">
        
        {/* Rendering Overlay */}
        {isRendering && (
           <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center">
               <div className="bg-slate-900 border border-slate-700 p-8 rounded-2xl shadow-2xl max-w-md w-full text-center space-y-6">
                   <Loader2 className="w-16 h-16 animate-spin text-indigo-500 mx-auto" />
                   <div>
                       <h3 className="text-2xl font-bold text-white mb-2">Rendering Final Movie</h3>
                       <p className="text-slate-400">Merging video scenes, audio, and subtitles...</p>
                   </div>
                   
                   <div className="w-full bg-slate-800 rounded-full h-4 overflow-hidden">
                       <div 
                         className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full transition-all duration-300"
                         style={{ width: `${renderProgress}%` }}
                       ></div>
                   </div>
                   <p className="text-xs text-slate-500">Do not close this tab.</p>
               </div>
           </div>
        )}

        {/* Step 1: Input */}
        {state.step === 'input' && (
          <div className="flex flex-col items-center justify-center h-80 bg-slate-900/50 rounded-3xl p-8 shadow-2xl border border-slate-800 backdrop-blur-sm">
            <h2 className="text-3xl font-bold mb-8">What story shall we tell today?</h2>
            <div className="flex w-full max-w-xl gap-3 relative group">
              <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <input 
                type="text" 
                value={state.bookName}
                onChange={(e) => setState(prev => ({ ...prev, bookName: e.target.value }))}
                placeholder="Enter a book title (e.g., The Little Prince)..."
                className="relative z-10 flex-grow bg-slate-900 border-2 border-slate-700 rounded-xl px-6 py-4 focus:outline-none focus:border-indigo-500 text-xl transition-colors placeholder-slate-600"
                onKeyDown={(e) => e.key === 'Enter' && handleGenerateStory()}
              />
              <button 
                onClick={handleGenerateStory}
                disabled={loading}
                className="relative z-10 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-8 py-4 rounded-xl font-bold flex items-center gap-2 transition-all shadow-lg hover:shadow-indigo-500/25"
              >
                {loading ? <Loader2 className="animate-spin" /> : <Search />}
                Start
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Story Editor */}
        {state.step === 'story-gen' && state.storyMetadata && (
          <div className="space-y-8 animate-fade-in">
             {/* Global Settings */}
             <div className="bg-slate-900/80 rounded-2xl p-6 border border-slate-700 shadow-xl">
               <div className="flex flex-col md:flex-row justify-between items-start mb-6 gap-4">
                 <div className="flex-grow">
                    <h3 className="text-2xl font-bold text-white mb-2">{state.storyMetadata.title}</h3>
                    <p className="text-slate-400 max-w-2xl">{state.storyMetadata.summary}</p>
                 </div>

                 {state.storyMetadata.sources && state.storyMetadata.sources.length > 0 && (
                   <div className="text-right text-xs text-slate-500 hidden lg:block">
                     <span className="block mb-1 font-semibold">Sources:</span>
                     {state.storyMetadata.sources.slice(0, 3).map((url, i) => (
                       <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block text-indigo-400 hover:underline truncate w-40">{new URL(url).hostname}</a>
                     ))}
                   </div>
                 )}
               </div>

               <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4 border-t border-slate-800">
                  <div className="group">
                    <label className="flex items-center gap-2 text-indigo-400 font-bold mb-2 uppercase text-xs tracking-wider">
                      <ImageIcon className="w-4 h-4" /> Visual Style
                      <span className="text-slate-600 font-normal normal-case ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">(Edit to change)</span>
                    </label>
                    <textarea 
                      value={state.storyMetadata.visualStyle}
                      onChange={(e) => updateMetadata('visualStyle', e.target.value)}
                      className="w-full bg-slate-950/50 border-b-2 border-slate-700 focus:border-indigo-500 outline-none p-3 rounded-lg text-sm text-slate-200 transition-colors resize-none h-24 hover:bg-slate-950"
                    />
                  </div>
                  <div className="group">
                    <label className="flex items-center gap-2 text-indigo-400 font-bold mb-2 uppercase text-xs tracking-wider">
                      <Edit2 className="w-4 h-4" /> Character Description
                      <span className="text-slate-600 font-normal normal-case ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">(Edit to change)</span>
                    </label>
                    <textarea 
                      value={state.storyMetadata.characterDescription}
                      onChange={(e) => updateMetadata('characterDescription', e.target.value)}
                      className="w-full bg-slate-950/50 border-b-2 border-slate-700 focus:border-indigo-500 outline-none p-3 rounded-lg text-sm text-slate-200 transition-colors resize-none h-24 hover:bg-slate-950"
                    />
                  </div>
               </div>
             </div>

             {/* Scene Editors */}
             <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
               {state.scenes.map((scene, idx) => (
                 <div key={scene.id} className="bg-slate-800 rounded-xl p-5 border border-slate-700 hover:border-slate-600 transition-colors flex flex-col gap-4 shadow-lg">
                   <div className="flex justify-between items-center border-b border-slate-700 pb-2">
                     <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Scene {scene.id}</span>
                     <div className="flex items-center gap-2">
                        {scene.status === 'pending' && <span className="text-[10px] text-yellow-500 bg-yellow-900/20 px-2 py-1 rounded">Pending Gen</span>}
                        <button 
                            onClick={() => deleteScene(idx)}
                            className="text-slate-500 hover:text-red-400 hover:bg-slate-700/50 p-1.5 rounded-full transition-all"
                            title="Delete Scene"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                     </div>
                   </div>
                   
                   <div>
                      <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Narration (EN)</label>
                      <textarea 
                        value={scene.textEn}
                        onChange={(e) => updateScene(idx, 'textEn', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-white focus:border-indigo-500 outline-none resize-none h-20"
                      />
                   </div>

                   <div>
                      <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Narration (ZH)</label>
                      <textarea 
                        value={scene.textZh}
                        onChange={(e) => updateScene(idx, 'textZh', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-300 focus:border-indigo-500 outline-none resize-none h-16"
                      />
                   </div>

                   <div>
                      <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Visual Prompt</label>
                      <textarea 
                        value={scene.visualPrompt}
                        onChange={(e) => updateScene(idx, 'visualPrompt', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-400 focus:border-indigo-500 outline-none resize-none h-24"
                      />
                   </div>

                   <div>
                      <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Voice Mood</label>
                      <input 
                        type="text"
                        value={scene.voiceMood}
                        onChange={(e) => updateScene(idx, 'voiceMood', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:border-indigo-500 outline-none"
                      />
                   </div>
                 </div>
               ))}
               
               {/* Add Scene Card */}
               <button 
                  onClick={addScene}
                  className="bg-slate-800/50 border-2 border-dashed border-slate-700 rounded-xl p-5 flex flex-col items-center justify-center text-slate-500 hover:text-indigo-400 hover:border-indigo-500/50 hover:bg-slate-800 transition-all gap-2 min-h-[300px] group"
               >
                  <div className="bg-slate-700 group-hover:bg-indigo-500/20 p-4 rounded-full transition-colors">
                     <Plus className="w-8 h-8" />
                  </div>
                  <span className="font-bold">Add New Scene</span>
               </button>
             </div>

             {/* Video Output Settings - MOVED HERE */}
             <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-700 shadow-xl w-full max-w-3xl mx-auto backdrop-blur-sm">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
                    <Settings className="w-5 h-5 text-indigo-400" /> 
                    Video Output Settings
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700">
                        <label className="text-xs text-slate-400 flex items-center gap-2 mb-3 font-bold uppercase tracking-wider">
                            <Monitor className="w-4 h-4"/> Resolution
                        </label>
                        <div className="flex gap-2">
                            {['720p', '1080p'].map((res) => (
                                <button
                                    key={res}
                                    onClick={() => updateVideoSettings('resolution', res)}
                                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold transition-all border ${
                                        state.videoSettings.resolution === res 
                                        ? 'bg-indigo-600 border-indigo-500 text-white' 
                                        : 'bg-slate-900 border-slate-700 text-slate-400'
                                    }`}
                                >
                                    {res}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700">
                        <label className="text-xs text-slate-400 flex items-center gap-2 mb-3 font-bold uppercase tracking-wider">
                            <Smartphone className="w-4 h-4"/> Aspect Ratio
                        </label>
                        <div className="flex gap-2">
                            {[
                                { val: '16:9', label: 'Landscape' },
                                { val: '9:16', label: 'Portrait' }
                            ].map((opt) => (
                                <button
                                    key={opt.val}
                                    onClick={() => updateVideoSettings('aspectRatio', opt.val)}
                                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold transition-all border ${
                                        state.videoSettings.aspectRatio === opt.val 
                                        ? 'bg-indigo-600 border-indigo-500 text-white' 
                                        : 'bg-slate-900 border-slate-700 text-slate-400'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                <p className="text-xs text-slate-500 mt-4 text-center">
                    Note: If "Character Consistency" (Step 3) is used, final videos will be locked to <strong>720p 16:9</strong> due to AI model limitations.
                </p>
             </div>

             <div className="flex justify-center pt-2">
                <button 
                  onClick={handleGenerateReference}
                  disabled={loading}
                  className="group bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white px-8 py-4 rounded-full font-bold text-lg shadow-lg shadow-indigo-500/30 flex items-center gap-3 transition-all hover:scale-105"
                >
                  {loading ? <Loader2 className="animate-spin" /> : (
                      <>
                        Generate Character
                        <ArrowRight className="group-hover:translate-x-1 transition-transform" />
                      </>
                  )}
                </button>
             </div>
          </div>
        )}

        {/* Step 3: Reference Image */}
        {state.step === 'ref-image-gen' && state.referenceImageUrl && (
          <div className="flex flex-col items-center space-y-8 animate-fade-in py-10">
             <div className="text-center space-y-2">
                <h2 className="text-3xl font-bold">Character Reference</h2>
                <p className="text-slate-400 max-w-lg mx-auto">This asset guides Veo to keep your character looking consistent across all video clips.</p>
             </div>
             
             <div className="relative group">
               <div className="absolute inset-0 bg-indigo-500/20 blur-2xl rounded-full -z-10"></div>
               <img 
                src={state.referenceImageUrl} 
                alt="Reference" 
                className="w-72 h-72 md:w-96 md:h-96 object-cover rounded-2xl shadow-2xl border-4 border-slate-800" 
               />
               <button 
                  onClick={handleGenerateReference}
                  className="absolute top-4 right-4 bg-black/60 hover:bg-black/80 p-2 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Regenerate Reference"
               >
                   <RefreshCw className="w-5 h-5" />
               </button>
             </div>
             
             <div className="flex justify-center gap-6 pt-2">
                <button 
                  onClick={() => jumpToStep('story-gen')}
                  className="px-6 py-3 rounded-xl border border-slate-600 hover:bg-slate-800 text-slate-300 transition-colors"
                >
                  Edit Story & Character
                </button>
                <button 
                  onClick={handleGenerateAssets}
                  disabled={loading}
                  className="bg-green-600 hover:bg-green-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-green-900/20 flex items-center gap-2 transition-transform hover:scale-105"
                >
                  {loading ? <Loader2 className="animate-spin" /> : (
                    <>
                        <Video />
                        Produce Video Scenes
                    </>
                  )}
                </button>
             </div>
             <p className="text-xs text-slate-500 max-w-md text-center">
                Note: Veo generation requires a paid Google Cloud Project. Please select your key in the popup if prompted.
             </p>
          </div>
        )}

        {/* Step 4 & 5: Generation Status & Final Player */}
        {(state.step === 'video-gen' || state.step === 'finished') && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fade-in h-[calc(100vh-200px)] min-h-[600px]">
            
            {/* Left: Playlist / Status */}
            <div className="lg:col-span-1 flex flex-col gap-4 h-full">
              <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <h3 className="font-bold flex items-center gap-2">
                  <Video className="w-5 h-5 text-indigo-400" /> Storyboard
                </h3>
                <div className="flex gap-2">
                  {state.scenes.some(s => s.status !== 'completed' && s.status !== 'generating') && (
                      <button 
                          onClick={handleGenerateAssets}
                          className="text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded-full flex items-center gap-1"
                      >
                          <RefreshCw className="w-3 h-3" /> Retry All
                      </button>
                  )}
                </div>
              </div>

              <div className="flex-grow overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                {state.scenes.map((scene, index) => (
                  <button
                    key={scene.id}
                    onClick={() => {
                        if (scene.status === 'completed') {
                            setActiveSceneIndex(index);
                            setIsPlaying(true);
                        }
                    }}
                    disabled={scene.status === 'pending' || scene.status === 'generating'}
                    className={`w-full text-left p-4 rounded-xl border transition-all relative overflow-hidden group ${
                      activeSceneIndex === index 
                        ? 'bg-slate-800 border-indigo-500 ring-1 ring-indigo-500' 
                        : 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
                    } ${scene.status !== 'completed' ? 'opacity-80' : ''}`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className={`font-bold ${activeSceneIndex === index ? 'text-indigo-300' : 'text-slate-300'}`}>Scene {scene.id}</span>
                      <div className="flex items-center gap-2">
                          {scene.status === 'generating' && <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />}
                          {scene.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                          {scene.status === 'error' && <div className="w-2 h-2 rounded-full bg-red-500" />}
                          {scene.status === 'pending' && <div className="text-[10px] uppercase font-bold text-slate-500 bg-slate-900 px-2 rounded">Pending</div>}
                          
                          {/* Regenerate Button */}
                          {(scene.status === 'completed' || scene.status === 'error') && (
                              <div 
                                onClick={(e) => regenerateScene(e, index)}
                                className="p-1.5 rounded-full hover:bg-slate-700 text-slate-500 hover:text-indigo-400 transition-colors z-20 cursor-pointer"
                                title="Regenerate Scene"
                              >
                                  <RefreshCw className="w-3 h-3" />
                              </div>
                          )}
                      </div>
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2 group-hover:text-slate-400 transition-colors">{scene.textEn}</p>
                    
                    {scene.status === 'generating' && (
                        <div className="absolute bottom-0 left-0 h-1 bg-indigo-500/30 w-full">
                            <div className="h-full bg-indigo-500 animate-pulse w-2/3"></div>
                        </div>
                    )}
                  </button>
                ))}
              </div>
              
              {/* Logs Area */}
              <div className="bg-black/40 p-3 rounded-xl font-mono text-[10px] text-green-400/80 h-32 overflow-y-auto border border-slate-800 shadow-inner">
                  {state.logs.map((log, i) => <div key={i} className="mb-1">{log}</div>)}
                  {loading && <div className="animate-pulse">_</div>}
                  <div ref={logsEndRef} />
              </div>
            </div>

            {/* Right: Player */}
            <div className="lg:col-span-2 flex flex-col h-full gap-4">
               {/* Player Header with Export */}
               {state.step === 'finished' && state.scenes.every(s => s.status === 'completed') && (
                 <div className="flex justify-end">
                    <button 
                      onClick={handleExportMovie}
                      disabled={isRendering}
                      className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 text-sm shadow-lg shadow-purple-500/20 transition-all hover:scale-105"
                    >
                      {isRendering ? <Loader2 className="animate-spin w-4 h-4" /> : <Film className="w-4 h-4" />}
                      Export Full Movie (Merged)
                    </button>
                 </div>
               )}

               <div className="flex-grow bg-black rounded-3xl overflow-hidden shadow-2xl border border-slate-800 relative flex flex-col items-center justify-center group">
                  
                  {state.scenes[activeSceneIndex]?.status === 'completed' ? (
                      <>
                        <video 
                            ref={videoRef}
                            src={state.scenes[activeSceneIndex].videoUrl} 
                            className="w-full h-full object-contain"
                            playsInline
                            loop 
                            muted
                        />
                        <audio 
                            ref={audioRef}
                            src={state.scenes[activeSceneIndex].audioUrl}
                            onEnded={handleSceneEnd}
                            onTimeUpdate={handleTimeUpdate}
                        />
                        
                        {/* Dynamic Subtitles Overlay */}
                        <div className="absolute bottom-20 left-0 right-0 px-12 text-center space-y-4 pointer-events-none transition-opacity duration-300">
                           {currentSubtitle && (
                               <>
                                   <div className="inline-block animate-fade-in-up">
                                        <span className="bg-black/60 text-white px-6 py-3 rounded-2xl text-xl font-medium backdrop-blur-md shadow-lg box-decoration-clone leading-[3rem]">
                                            {currentSubtitle.textEn}
                                        </span>
                                    </div>
                                    <br />
                                    <div className="inline-block animate-fade-in-up">
                                        <span className="bg-black/60 text-yellow-300 px-4 py-2 rounded-xl text-lg font-medium backdrop-blur-md shadow-lg box-decoration-clone">
                                            {currentSubtitle.textZh}
                                        </span>
                                    </div>
                               </>
                           )}
                        </div>

                        {/* Centered Play Button (if paused) */}
                        {!isPlaying && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none">
                                <div className="bg-white/20 p-6 rounded-full backdrop-blur-md border border-white/30 shadow-2xl">
                                    <Play className="w-12 h-12 text-white ml-2" />
                                </div>
                            </div>
                        )}
                      </>
                  ) : (
                      <div className="text-slate-500 flex flex-col items-center p-12 text-center">
                          {state.scenes[activeSceneIndex]?.status === 'generating' ? (
                              <>
                                <Loader2 className="w-16 h-16 animate-spin mb-6 text-indigo-500" />
                                <h4 className="text-xl font-bold text-white mb-2">Generating Scene {activeSceneIndex + 1}</h4>
                                <p>Veo is creating your video... (~45s)</p>
                              </>
                          ) : (
                              <>
                                <Video className="w-16 h-16 mb-4 opacity-20" />
                                <p>Select a completed scene to play or wait for generation.</p>
                              </>
                          )}
                      </div>
                  )}
               </div>

               {/* Video Controls & Download */}
               {state.scenes[activeSceneIndex]?.status === 'completed' && (
                   <div className="bg-slate-900 rounded-xl p-4 flex items-center justify-between border border-slate-800">
                       <div className="flex items-center gap-4">
                            <button 
                                onClick={() => setIsPlaying(!isPlaying)}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white p-3 rounded-full transition-transform hover:scale-105 shadow-lg shadow-indigo-500/20"
                            >
                                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-1" />}
                            </button>
                            <div className="text-sm text-slate-300 font-medium">
                                Scene {activeSceneIndex + 1} / {state.scenes.length}
                            </div>
                       </div>

                       <div className="flex gap-2">
                            <a 
                                href={state.scenes[activeSceneIndex].videoUrl} 
                                download={`scene-${activeSceneIndex+1}-video.mp4`}
                                className="flex items-center gap-2 text-xs bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg transition-colors border border-slate-700"
                            >
                                <Download className="w-3 h-3" /> Video
                            </a>
                            <a 
                                href={state.scenes[activeSceneIndex].audioUrl} 
                                download={`scene-${activeSceneIndex+1}-audio.wav`}
                                className="flex items-center gap-2 text-xs bg-slate-800 hover:bg-slate-700 px-3 py-2 rounded-lg transition-colors border border-slate-700"
                            >
                                <Volume2 className="w-3 h-3" /> Audio
                            </a>
                       </div>
                   </div>
               )}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
