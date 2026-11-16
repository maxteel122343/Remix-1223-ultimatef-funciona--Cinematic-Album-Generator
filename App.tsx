
import React, { useState, useEffect, useCallback } from 'react';
import { analyzePhoto, generateStoryPhoto } from './services/geminiService';
import { GeneratedPhoto, StoryChapter, UserProfile, CREDIT_COSTS } from './types';
import { supabase } from './lib/supabase';
import { GoogleGenAI } from "@google/genai";

const CHAPTERS: StoryChapter[] = [
  { title: "Arrival", prompt: "The person just arrived at the location, looking around with a happy expression and carrying a small bag or hat." },
  { title: "Exploration", prompt: "The person is walking through the environment, exploring and looking at the scenery from a different angle (full body shot)." },
  { title: "Relaxation", prompt: "The person is sitting down comfortably, enjoying a local drink or snack, looking relaxed and candid." },
  { title: "Sunset Magic", prompt: "A close-up shot of the person smiling warmly as the lighting becomes golden and soft, capturing a beautiful memory." }
];

const UNIVERSAL_RECEIVER_ID = "INSTASTORY_AI_V1";
const ANONYMOUS_SENDER_ID = "00000000-0000-4000-a000-000000000000";
const BRIDGE_PREFIX = "INSTA-BRIDGE:";
const GEN_PREFIX = "INSTA-GEN:";
const VAULT_PREFIX = "VAULT-SECURE:";

const SQL_SETUP = `-- 🟢 EVOLUÇÃO PARA MULTI-VAULT
CREATE TABLE IF NOT EXISTS vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  reference_image_path text,
  is_active boolean DEFAULT false,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id text NOT NULL,
  status text DEFAULT 'pending',
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id),
  vault_id uuid REFERENCES vaults(id),
  type text CHECK (type IN ('input', 'output')),
  image_path text NOT NULL,
  created_at timestamp DEFAULT now()
);

-- RLS
ALTER TABLE vaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all vaults" ON vaults FOR ALL USING (true) WITH CHECK (true);
`;

interface Vault {
  id: string;
  name: string;
  reference_image_path?: string;
  reference_url?: string;
  is_active: boolean;
  created_at: string;
}

interface BucketImage {
  id: string;
  image_path: string;
  job_id: string;
  vault_id?: string;
  url?: string;
  type: 'input' | 'output';
}

const App: React.FC = () => {
  // State
  const [showVaultModal, setShowVaultModal] = useState(false);
  const [galleryTab, setGalleryTab] = useState<'inputs' | 'generated'>('inputs');
  const [credits, setCredits] = useState(100);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [photos, setPhotos] = useState<GeneratedPhoto[]>([]);
  const [statusText, setStatusText] = useState("");
  const [notification, setNotification] = useState<{msg: string, type: 'info' | 'error' | 'success'} | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'checking' | 'sending' | 'receiving'>('idle');
  
  // Vaults Management
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);

  // Logic modes
  const [serviceMode, setServiceMode] = useState<'local' | 'remote'>('local');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [universalLink, setUniversalLink] = useState<string | null>(null);
  const [genLink, setGenLink] = useState<string | null>(null);
  const [remoteAddressInput, setRemoteAddressInput] = useState("");
  const [autoUpload, setAutoUpload] = useState(false);
  
  // Galleries
  const [inputImages, setInputImages] = useState<BucketImage[]>([]);
  const [outputImages, setOutputImages] = useState<BucketImage[]>([]);
  const [selectedBucketImage, setSelectedBucketImage] = useState<BucketImage | null>(null);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const notify = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
    setNotification({ msg, type });
  };

  // --- VAULT LOGIC ---
  const fetchVaults = useCallback(async () => {
    const { data, error } = await supabase.from('vaults').select('*').order('created_at', { ascending: false });
    if (data) {
      const vaultsWithUrls = await Promise.all(data.map(async v => {
        if (v.reference_image_path) {
          const { data: url } = supabase.storage.from('images-bridge').getPublicUrl(v.reference_image_path);
          return { ...v, reference_url: url.publicUrl };
        }
        return v;
      }));
      setVaults(vaultsWithUrls);
      const active = vaultsWithUrls.find(v => v.is_active);
      if (active) setActiveVaultId(active.id);
    }
  }, []);

  useEffect(() => { fetchVaults(); }, [fetchVaults]);

  const createVault = async () => {
    const name = prompt("Nome do novo Vault Secure:");
    if (!name) return;
    const { data, error } = await supabase.from('vaults').insert({ name }).select().single();
    if (data) {
      notify("Novo Vault Criado!", "success");
      fetchVaults();
    }
  };

  const toggleVaultActive = async (id: string) => {
    // Deactivate others
    await supabase.from('vaults').update({ is_active: false }).neq('id', id);
    // Activate this one
    const { error } = await supabase.from('vaults').update({ is_active: true }).eq('id', id);
    if (!error) {
      setActiveVaultId(id);
      fetchVaults();
      notify("Vault Ativado com Sucesso!", "success");
    }
  };

  // --- REFRESH GALLERIES ---
  const fetchGalleries = useCallback(async () => {
    if (!selectedVaultId) return;
    setBridgeStatus('checking');
    try {
      const { data, error } = await supabase.from('images')
        .select('*')
        .eq('vault_id', selectedVaultId)
        .order('created_at', { ascending: false });
      
      if (error) throw error;

      const itemsWithUrls = await Promise.all((data || []).map(async (img) => {
        const { data: publicUrl } = supabase.storage.from('images-bridge').getPublicUrl(img.image_path);
        return { ...img, url: publicUrl.publicUrl };
      }));

      setInputImages(itemsWithUrls.filter(i => i.type === 'input'));
      setOutputImages(itemsWithUrls.filter(i => i.type === 'output'));
    } catch (err) { console.error(err); } 
    finally { setBridgeStatus('idle'); }
  }, [selectedVaultId]);

  useEffect(() => { if (showVaultModal) fetchGalleries(); }, [showVaultModal, fetchGalleries]);

  // --- ACTIONS ---
  const uploadToBucket = async (jobId: string, base64: string, type: 'input' | 'output', chapter?: string) => {
    try {
      const res = await fetch(base64);
      const blob = await res.blob();
      const fileName = type === 'input' ? 'input.png' : `output-${chapter?.toLowerCase()}-${Date.now()}.png`;
      const filePath = `${jobId}/${fileName}`;

      await supabase.storage.from("images-bridge").upload(filePath, blob);
      await supabase.from("images").insert({ 
        job_id: jobId, 
        vault_id: activeVaultId, 
        type: type, 
        image_path: filePath 
      });
      return filePath;
    } catch (e) { console.error("Upload Error:", e); return null; }
  };

  const executeGeneration = async (targetImg: string, jobId: string) => {
    setIsProcessing(true);
    setPhotos([]);
    setProgress(0);
    
    try {
      const { description, location } = await analyzePhoto(targetImg);
      const generated: GeneratedPhoto[] = [];
      
      for (let i = 0; i < CHAPTERS.length; i++) {
        setStatusText(`Sintetizando: ${CHAPTERS[i].title}...`);
        const photoUrl = await generateStoryPhoto(targetImg, description, location, CHAPTERS[i].prompt);
        if (photoUrl) {
          const newPhoto = { id: `gen-${Date.now()}-${i}`, url: photoUrl, caption: CHAPTERS[i].prompt, chapter: CHAPTERS[i].title };
          generated.push(newPhoto);
          setPhotos([...generated]);
          // Auto-save to vault
          await uploadToBucket(jobId, photoUrl, 'output', CHAPTERS[i].title);
        }
        setProgress(((i + 1) / CHAPTERS.length) * 100);
      }
      
      await supabase.from("jobs").update({ status: 'done' }).eq("id", jobId);
      setStatusText("Processamento Finalizado!");
      notify("Álbum salvo no Vault Ativo!", "success");
    } catch (e: any) { notify("Erro IA: " + e.message, "error"); } 
    finally { setIsProcessing(false); }
  };

  const handleRemoteProcess = async () => {
    if (!originalImage) return notify("Selecione uma foto primeiro!", "error");
    if (!remoteAddressInput.startsWith(GEN_PREFIX)) return notify("Endereço remoto inválido!", "error");
    const targetJobId = remoteAddressInput.replace(GEN_PREFIX, "").trim();
    executeGeneration(originalImage, targetJobId);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      const r = new FileReader();
      r.onload = async (x) => {
        const b64 = x.target?.result as string;
        setOriginalImage(b64);
        if (autoUpload && activeVaultId) {
          setBridgeStatus('sending');
          const { data: job } = await supabase.from("jobs").insert({ sender_id: ANONYMOUS_SENDER_ID, receiver_id: UNIVERSAL_RECEIVER_ID }).select().single();
          if (job) {
            await uploadToBucket(job.id, b64, 'input');
            // If vault has no reference, set this one
            const currentVault = vaults.find(v => v.id === activeVaultId);
            if (!currentVault?.reference_image_path) {
                const path = `${job.id}/input.png`;
                await supabase.from('vaults').update({ reference_image_path: path }).eq('id', activeVaultId);
                fetchVaults();
            }
            setActiveJobId(job.id);
            setUniversalLink(`${BRIDGE_PREFIX}${job.id}`);
            setGenLink(`${GEN_PREFIX}${job.id}`);
            setBridgeStatus('idle');
            notify("Imagem protegida no Vault Ativo!", "success");
          }
        }
      };
      r.readAsDataURL(f);
    }
  };

  const importSelected = async () => {
    if (!selectedBucketImage) return;
    setBridgeStatus('receiving');
    try {
      const { data: blob } = await supabase.storage.from("images-bridge").download(selectedBucketImage.image_path);
      if (blob) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setOriginalImage(reader.result as string);
          setActiveJobId(selectedBucketImage.job_id);
          setUniversalLink(`${BRIDGE_PREFIX}${selectedBucketImage.job_id}`);
          setGenLink(`${GEN_PREFIX}${selectedBucketImage.job_id}`);
          setPhotos([]);
          setShowVaultModal(false);
          notify("Importação Concluída!", "success");
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) { notify("Erro no download", "error"); }
    finally { setBridgeStatus('idle'); }
  };

  // Fix: Added missing generateNewGenId function to create a new job entry and update the UI links
  const generateNewGenId = async () => {
    setBridgeStatus('sending');
    try {
      const { data: job, error } = await supabase.from("jobs").insert({ 
        sender_id: ANONYMOUS_SENDER_ID, 
        receiver_id: UNIVERSAL_RECEIVER_ID 
      }).select().single();
      
      if (error) throw error;

      if (job) {
        setActiveJobId(job.id);
        setUniversalLink(`${BRIDGE_PREFIX}${job.id}`);
        setGenLink(`${GEN_PREFIX}${job.id}`);
        notify("Nova Chave de Geração Criada!", "success");
      }
    } catch (err: any) {
      console.error(err);
      notify("Erro ao gerar nova chave", "error");
    } finally {
      setBridgeStatus('idle');
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 font-sans selection:bg-indigo-500/30">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 glass border-b border-white/5 px-10 py-5 flex justify-between items-center shadow-2xl">
        <div className="flex items-center gap-4 group cursor-pointer" onClick={() => window.location.reload()}>
          <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <i className="fa-solid fa-vault text-white"></i>
          </div>
          <div className="flex flex-col">
            <h1 className="text-2xl font-black italic tracking-tighter text-white">VAULT SECURE</h1>
            <span className="text-[7px] font-bold uppercase tracking-[0.5em] text-indigo-400">High-Security Storage Protocol</span>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          {activeVaultId && (
            <div className="hidden md:flex flex-col items-end mr-4 animate-fadeIn">
               <span className="text-[7px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1">
                 <i className="fa-solid fa-circle text-[4px] animate-pulse"></i> Vault Ativo
               </span>
               <span className="text-[10px] font-black text-white italic">{vaults.find(v => v.id === activeVaultId)?.name}</span>
            </div>
          )}
          <button onClick={() => setShowVaultModal(true)} className="bg-indigo-600/10 hover:bg-indigo-600/20 px-6 py-3 rounded-2xl border border-indigo-500/30 text-[10px] font-black uppercase tracking-widest transition-all">
             <i className="fa-solid fa-folder-tree mr-2"></i> Vault Manager
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto pt-36 px-6 pb-32">
        {!originalImage ? (
          <div className="space-y-16 animate-fadeIn">
            <div className="text-center space-y-6">
              <h2 className="text-6xl md:text-8xl font-black tracking-tighter italic leading-[0.9]">
                Multiple Vaults. <br/> <span className="text-indigo-600">Infinite IDs.</span>
              </h2>
              <p className="text-slate-500 font-medium text-xl max-w-2xl mx-auto">Crie cofres isolados para cada projeto. Gere endereços únicos para cada álbum.</p>
            </div>

            <div className="max-w-xl mx-auto">
               <div className="relative group">
                  <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-[2.5rem] blur opacity-10 group-hover:opacity-30 transition duration-1000"></div>
                  <label className="relative block bg-slate-900/40 border border-white/10 backdrop-blur-3xl rounded-[2.5rem] p-12 cursor-pointer text-center group hover:bg-slate-900/60 transition shadow-3xl">
                     {!activeVaultId && (
                       <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center rounded-[2.5rem] p-8 text-center">
                         <i className="fa-solid fa-lock text-3xl text-indigo-500 mb-4"></i>
                         <p className="text-xs font-black uppercase tracking-widest mb-4">Selecione ou crie um Vault para habilitar upload</p>
                         <button onClick={() => setShowVaultModal(true)} className="bg-indigo-600 px-6 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest">Abrir Vault Manager</button>
                       </div>
                     )}
                     <i className="fa-solid fa-plus-circle text-5xl text-indigo-500 mb-4 block group-hover:scale-110 transition"></i>
                     <h3 className="text-lg font-black italic mb-1">Upload de Nova Identidade</h3>
                     <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Envia para: {vaults.find(v => v.id === activeVaultId)?.name || 'Nenhum'}</p>
                     <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} disabled={!activeVaultId} />
                  </label>
               </div>
               
               <div className="flex items-center justify-center gap-4 mt-8 opacity-60">
                 <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Auto-Vault Upload</span>
                 <button onClick={() => setAutoUpload(!autoUpload)} className={`w-12 h-6 rounded-full transition-all relative flex items-center px-1 ${autoUpload ? 'bg-indigo-600' : 'bg-slate-800'}`}>
                    <div className={`w-4 h-4 bg-white rounded-full transition-all ${autoUpload ? 'translate-x-6' : 'translate-x-0'}`}></div>
                 </button>
               </div>
            </div>
          </div>
        ) : (
          <div className="space-y-12 animate-fadeIn">
            <div className="glass p-10 rounded-[4rem] shadow-3xl border-white/5 relative">
              <div className="flex flex-col lg:flex-row items-center gap-10">
                <div className="relative group shrink-0">
                  <img src={originalImage} className="w-40 h-40 object-cover rounded-[2.5rem] border-4 border-white/10 shadow-2xl" alt="Source" />
                  {!isProcessing && (
                    <button onClick={() => { setOriginalImage(null); setPhotos([]); }} className="absolute -top-4 -right-4 bg-red-600 w-11 h-11 rounded-2xl flex items-center justify-center text-white border-4 border-[#020617] hover:scale-110 transition shadow-xl"><i className="fa-solid fa-xmark"></i></button>
                  )}
                </div>

                <div className="flex-1 w-full space-y-8">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                    <div>
                      <span className="text-[10px] font-black uppercase tracking-[0.5em] text-indigo-400">Processing Engine</span>
                      <h3 className="text-2xl font-black italic">{isProcessing ? statusText : "Identidade Vinculada"}</h3>
                    </div>
                    <div className="bg-black/40 p-1.5 rounded-2xl border border-white/5 flex gap-2">
                      <button onClick={() => setServiceMode('local')} className={`px-5 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${serviceMode === 'local' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'}`}>Local</button>
                      <button onClick={() => setServiceMode('remote')} className={`px-5 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${serviceMode === 'remote' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:text-white'}`}>Remote</button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-end px-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Render Progress</span>
                      <span className="text-xl font-black italic text-indigo-400">{Math.round(progress)}%</span>
                    </div>
                    <div className="h-3 bg-slate-950 rounded-full overflow-hidden border border-white/5 p-1">
                      <div className="h-full bg-gradient-to-r from-indigo-600 to-purple-600 rounded-full transition-all duration-700 shadow-lg" style={{ width: `${progress}%` }}></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-12 pt-10 border-t border-white/5 flex flex-col gap-6">
                <div className={`transition-all duration-500 ${serviceMode === 'local' ? 'opacity-100' : 'opacity-20 pointer-events-none grayscale'}`}>
                   <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                      <div className="flex-1">
                        <h4 className="text-sm font-black italic text-indigo-400 uppercase tracking-widest mb-1">Serviço Local</h4>
                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Gera frames e salva no cofre ativo ({vaults.find(v => v.id === activeVaultId)?.name})</p>
                      </div>
                      <button disabled={isProcessing || serviceMode !== 'local'} onClick={() => executeGeneration(originalImage, activeJobId || 'local-job')} className="w-full md:w-auto bg-indigo-600 hover:bg-indigo-500 text-white px-12 py-5 rounded-2xl font-black uppercase text-[11px] tracking-[0.2em] shadow-xl transition active:scale-95 disabled:opacity-30">Processar Agora</button>
                   </div>
                </div>

                <div className={`transition-all duration-500 ${serviceMode === 'remote' ? 'opacity-100' : 'opacity-20 pointer-events-none grayscale'}`}>
                   <div className="flex flex-col md:flex-row items-center gap-4 bg-purple-500/5 p-6 rounded-3xl border border-purple-500/10">
                      <div className="w-12 h-12 bg-purple-600 rounded-xl flex items-center justify-center text-white shrink-0"><i className="fa-solid fa-terminal text-lg"></i></div>
                      <div className="flex-1 space-y-1">
                        <h4 className="text-[10px] font-black italic text-purple-400 uppercase tracking-widest">Endereço Remoto</h4>
                        <input value={remoteAddressInput} onChange={e => setRemoteAddressInput(e.target.value)} placeholder="INSTA-GEN:..." className="w-full bg-transparent border-none text-xs font-bold focus:outline-none placeholder:text-slate-700 text-purple-200" />
                      </div>
                      <button disabled={isProcessing || serviceMode !== 'remote'} onClick={handleRemoteProcess} className="w-full md:w-auto bg-purple-600 hover:bg-purple-500 text-white px-10 py-5 rounded-2xl font-black uppercase text-[10px] tracking-[0.1em] transition active:scale-95 disabled:opacity-30">Processar Remoto</button>
                   </div>
                </div>
              </div>

              {!isProcessing && (universalLink || genLink) && (
                <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-4 animate-fadeIn">
                   <div className="bg-slate-900/40 p-5 rounded-2xl border border-white/5 flex items-center justify-between">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Universal ID</span>
                      <code className="text-[10px] font-mono text-indigo-300">{universalLink}</code>
                      <button onClick={() => { navigator.clipboard.writeText(universalLink!); notify("Copiado!", "success"); }} className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center"><i className="fa-solid fa-copy text-[10px]"></i></button>
                   </div>
                   <div className="bg-indigo-600/10 p-5 rounded-2xl border border-indigo-500/20 flex items-center justify-between">
                      <span className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Remote Gen Key</span>
                      <code className="text-[10px] font-mono text-indigo-100">{genLink}</code>
                      <button onClick={generateNewGenId} className="w-8 h-8 bg-indigo-600/20 text-indigo-400 rounded-lg flex items-center justify-center hover:bg-indigo-600 hover:text-white transition"><i className="fa-solid fa-arrows-rotate text-[10px]"></i></button>
                   </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              {photos.map((p, i) => (
                <div key={p.id} className="bg-slate-900/20 rounded-[4rem] border border-white/5 aspect-[4/5] overflow-hidden relative group shadow-2xl animate-fadeIn">
                  <img src={p.url} className="w-full h-full object-cover group-hover:scale-110 transition duration-[2s]" alt={p.chapter} />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#020617] via-transparent to-transparent opacity-90"></div>
                  <div className="absolute bottom-12 left-12">
                    <span className="text-[10px] font-black uppercase tracking-[0.5em] text-indigo-400">Bio Frame {i + 1}</span>
                    <h4 className="text-3xl font-black italic tracking-tighter text-white">{p.chapter}</h4>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Vault Manager Modal */}
      {showVaultModal && (
        <div className="fixed inset-0 z-[100] modal-backdrop flex items-center justify-center p-6" onClick={() => setShowVaultModal(false)}>
          <div className="bg-[#0f172a] w-full max-w-7xl max-h-[90vh] rounded-[3.5rem] border border-white/10 overflow-hidden flex shadow-3xl animate-fadeIn" onClick={e => e.stopPropagation()}>
            
            {/* Vault List Sidebar */}
            <div className="w-80 border-r border-white/5 bg-slate-950/50 flex flex-col">
               <div className="p-8 border-b border-white/5 flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Vaults List</h3>
                  <button onClick={createVault} className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center hover:bg-indigo-500 transition shadow-lg shadow-indigo-500/20">
                    <i className="fa-solid fa-plus text-xs"></i>
                  </button>
               </div>
               <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {vaults.map(v => (
                    <div 
                      key={v.id} 
                      onClick={() => setSelectedVaultId(v.id)}
                      className={`p-4 rounded-2xl cursor-pointer transition-all border flex items-center gap-3 ${selectedVaultId === v.id ? 'bg-indigo-600/10 border-indigo-500/50' : 'border-transparent hover:bg-white/5'}`}
                    >
                       <div className="w-10 h-10 rounded-xl bg-slate-800 overflow-hidden flex items-center justify-center shrink-0 border border-white/5">
                          {v.reference_url ? <img src={v.reference_url} className="w-full h-full object-cover" /> : <i className="fa-solid fa-lock text-[10px] text-slate-600"></i>}
                       </div>
                       <div className="flex-1 truncate">
                          <p className="text-[10px] font-black uppercase text-white truncate">{v.name}</p>
                          <p className="text-[8px] font-bold text-slate-500">{v.is_active ? 'Vault Ativo' : 'Offline'}</p>
                       </div>
                    </div>
                  ))}
               </div>
            </div>

            {/* Vault Content Area */}
            <div className="flex-1 flex flex-col bg-slate-900/20">
              {!selectedVaultId ? (
                <div className="flex-1 flex flex-col items-center justify-center opacity-30">
                  <i className="fa-solid fa-folder-open text-6xl mb-6"></i>
                  <p className="text-xs font-black uppercase tracking-widest">Selecione um Vault para explorar</p>
                </div>
              ) : (
                <>
                  <div className="p-10 border-b border-white/5 flex items-center justify-between">
                     <div className="flex items-center gap-6">
                        <div className="w-16 h-16 bg-slate-800 rounded-2xl flex items-center justify-center text-3xl">
                           <i className="fa-solid fa-shield-halved text-indigo-500"></i>
                        </div>
                        <div>
                           <h2 className="text-3xl font-black italic tracking-tight">{vaults.find(v => v.id === selectedVaultId)?.name}</h2>
                           <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.4em]">{VAULT_PREFIX}{selectedVaultId}</p>
                        </div>
                     </div>
                     <div className="flex items-center gap-4">
                        <div className="flex bg-slate-800 p-1.5 rounded-2xl">
                           <button onClick={() => setGalleryTab('inputs')} className={`px-6 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${galleryTab === 'inputs' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>Inputs</button>
                           <button onClick={() => setGalleryTab('generated')} className={`px-6 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${galleryTab === 'generated' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>Generated</button>
                        </div>
                        <button 
                          onClick={() => toggleVaultActive(selectedVaultId)}
                          className={`px-6 py-3 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all ${activeVaultId === selectedVaultId ? 'bg-emerald-600/20 text-emerald-500 border border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-white'}`}
                        >
                          {activeVaultId === selectedVaultId ? 'Ativo' : 'Ativar Vault'}
                        </button>
                     </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-10">
                     <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                        {(galleryTab === 'inputs' ? inputImages : outputImages).map(img => (
                          <div key={img.id} onClick={() => setSelectedBucketImage(img)} className={`relative aspect-square rounded-[2rem] overflow-hidden cursor-pointer border-4 transition-all group ${selectedBucketImage?.id === img.id ? 'border-indigo-500 shadow-2xl scale-105' : 'border-transparent'}`}>
                            <img src={img.url} className="w-full h-full object-cover" />
                            {selectedBucketImage?.id === img.id && <div className="absolute inset-0 bg-indigo-600/20 flex items-center justify-center"><i className="fa-solid fa-check text-white text-3xl"></i></div>}
                          </div>
                        ))}
                        {(galleryTab === 'inputs' ? inputImages : outputImages).length === 0 && (
                          <div className="col-span-full py-32 text-center opacity-20"><i className="fa-solid fa-ghost text-5xl mb-4 block"></i><p className="text-[10px] font-black uppercase tracking-widest">Nenhum registro encontrado</p></div>
                        )}
                     </div>
                  </div>

                  <div className="p-8 border-t border-white/5 flex justify-between items-center bg-slate-900/50">
                     <button onClick={() => { navigator.clipboard.writeText(SQL_SETUP); notify("SQL Copiado!", "success"); }} className="text-[10px] font-black uppercase text-slate-600 hover:text-indigo-400 transition tracking-widest">Security Script</button>
                     <div className="flex gap-4">
                        <button onClick={() => setShowVaultModal(false)} className="px-10 py-4 rounded-xl font-black text-[10px] uppercase bg-slate-800 border border-white/10 transition">Fechar</button>
                        <button disabled={!selectedBucketImage} onClick={importSelected} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-20 text-white px-12 py-4 rounded-xl font-black text-[10px] uppercase shadow-xl transition">Importar Identidade</button>
                     </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Notifications */}
      {notification && (
        <div className={`fixed bottom-12 left-1/2 -translate-x-1/2 z-[200] px-10 py-5 rounded-3xl font-black shadow-3xl animate-bounce border border-white/10 flex items-center gap-4 ${notification.type === 'error' ? 'bg-red-600' : 'bg-indigo-600'}`}>
          <i className={`fa-solid ${notification.type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-check'}`}></i>
          <span className="text-[11px] uppercase tracking-widest">{notification.msg}</span>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fadeIn { animation: fadeIn 0.5s ease-out forwards; }
        .glass { background: rgba(2, 6, 23, 0.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
        .shadow-3xl { box-shadow: 0 40px 100px -20px rgba(0,0,0,0.9); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 10px; }
      `}} />
    </div>
  );
};

export default App;
