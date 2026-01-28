import { useState, useRef, useEffect } from 'react';
import { NuanceCanvas, type NuanceCanvasHandle } from './components/NuanceCanvas';
import { type SoundProfile } from './core/SoundEngine';
import './App.css';

function App() {
  const canvasRef = useRef<NuanceCanvasHandle>(null);
  const [brushSize, setBrushSize] = useState(8);
  const [penOnly] = useState(true); // Default to Pen Mode
  const [soundProfile, setSoundProfile] = useState<SoundProfile>('pencil');
  const [soundVolume, setSoundVolume] = useState(0.5);
  const [smoothing, setSmoothing] = useState(0.5); // Default smoothing
  const [strokeColor, setStrokeColor] = useState('#333333');
  const [hapticEnabled, setHapticEnabled] = useState(false); // Default OFF
  const [frictionLevel, setFrictionLevel] = useState(0.5); // Paper friction (0-1)
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(true); // Collapsible toolbar

  useEffect(() => {
    // Check for embed mode
    const params = new URLSearchParams(window.location.search);
    if (params.get('embed') === 'true') {
      setIsEmbedMode(true);
    }
  }, []);

  const handleShare = async () => {
    if (!canvasRef.current) return;
    try {
      const dataUrl = await canvasRef.current.exportImage();
      if (!dataUrl) return;

      // 1. Convert DataURL to Blob for Sharing
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], `nuance-art-${Date.now()}.png`, { type: 'image/png' });

      // 2. Mobile/Tablet: Native Share Sheet (AirDrop, Zalo, Messenger)
      if (typeof navigator.share === 'function' && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'My Nuance Masterpiece',
          text: 'Created with Nuance - The Sensory Ink.'
        });
        return;
      }

      // 3. Desktop: Copy to Clipboard (for pasting into Obsidian/Notion)
      if (typeof navigator.clipboard !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          alert("✅ Đã copy ảnh vào Clipboard! (Paste ngay vào Obsidian/Notion nhé)"); // Simple feedback
          return;
        } catch (clipErr) {
          console.warn("Clipboard failed, falling back to download", clipErr);
        }
      }

      // 4. Fallback: Download File
      const link = document.createElement('a');
      link.download = `nuance-art-${Date.now()}.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

    } catch (err) {
      console.error("Export failed", err);
      alert("Export failed: " + (err as Error).message);
    }
  };

  const sizes = [4, 8, 12, 16]; // Compact set
  const colors = ['#333333', '#0055cc', '#cc3300', '#009944', '#663399', '#ffffff']; // Charcoal, Blue, Red, Green, Purple, Eraser(White)
  const networkUrl = "http://192.168.1.107:5173";

  const profiles: { id: SoundProfile, label: string, icon: string }[] = [
    { id: 'pencil', label: 'Pencil', icon: '✏️' },
    { id: 'charcoal', label: 'Charcoal', icon: '🌑' },
    { id: 'ballpoint', label: 'Ballpoint', icon: '🖊️' },
    { id: 'fountain', label: 'Fountain', icon: '✒️' },
    { id: 'calligraphy', label: 'Brush', icon: '🖌️' },
    { id: 'marker', label: 'Marker', icon: '🖍️' },
    { id: 'highlighter', label: 'Highlight', icon: '🖊️' },
    { id: 'monoline', label: 'Monoline', icon: '〰️' }
  ];

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      <NuanceCanvas
        ref={canvasRef}
        brushSize={brushSize}
        penOnly={penOnly}
        soundProfile={soundProfile}
        soundVolume={soundVolume}
        strokeColor={strokeColor}
        smoothing={smoothing}
        hapticEnabled={hapticEnabled}
        frictionLevel={frictionLevel}
      />

      {/* Network Info - Hidden in Embed Mode */}
      {!isEmbedMode && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(255, 255, 255, 0.4)', backdropFilter: 'blur(8px)',
          color: '#333', padding: '6px 16px',
          borderRadius: '20px', fontSize: '11px', fontWeight: 600,
          pointerEvents: 'none', zIndex: 9999,
          border: '1px solid rgba(255,255,255,0.2)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.05)'
        }}>
          {networkUrl}
        </div>
      )}

      {/* Control Dock */}
      {!isEmbedMode && (
        <div className={`nuance-dock ${toolbarExpanded ? '' : 'collapsed'}`}>

          {/* Toggle Button - Always visible */}
          <button
            className="dock-toggle"
            onClick={() => setToolbarExpanded(!toolbarExpanded)}
            title={toolbarExpanded ? 'Hide toolbar' : 'Show toolbar'}
          >
            {toolbarExpanded ? '▼' : '▲'}
          </button>

          {/* Toolbar Content - Collapsible */}
          {toolbarExpanded && (
            <>
              {/* Row 1: Main Tools (Undo/Redo, Colors, Sizes, Share) */}
              <div className="dock-row">
                {/* Undo/Redo */}
                <button
                  className="dock-btn btn-icon"
                  onClick={() => canvasRef.current?.undo()}
                  title="Undo"
                >
                  ↩️
                </button>
                <button
                  className="dock-btn btn-icon"
                  onClick={() => canvasRef.current?.redo()}
                  title="Redo"
                >
                  ↪️
                </button>
                <button
                  className="dock-btn btn-icon"
                  onClick={() => canvasRef.current?.clearAll()}
                  title="Clear All"
                >
                  🗑️
                </button>

                <div className="dock-divider" />

                {/* Export */}
                <button className="dock-btn btn-primary" onClick={handleShare}>
                  Export
                </button>

                <div className="dock-divider" />

                {/* Colors */}
                <div style={{ display: 'flex', gap: '6px' }}>
                  {colors.map(c => (
                    <div
                      key={c}
                      className={`color-swatch ${strokeColor === c ? 'active' : ''}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setStrokeColor(c)}
                    />
                  ))}
                </div>

                <div className="dock-divider" />

                {/* Sizes */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {sizes.map(size => (
                    <div
                      key={size}
                      className={`size-dot ${brushSize === size ? 'active' : ''}`}
                      onClick={() => setBrushSize(size)}
                      style={{
                        width: Math.max(14, size + 8),
                        height: Math.max(14, size + 8),
                        color: typeof strokeColor === 'string' ? strokeColor : '#333'
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Row 2: Physics + Profiles Combined */}
              <div className="dock-row">
                {/* Volume */}
                <div className="slider-group">
                  <div className="slider-label"><span>Vol</span> <span>{Math.round(soundVolume * 100)}%</span></div>
                  <input
                    type="range" min="0" max="100" step="5"
                    value={soundVolume * 100}
                    onChange={(e) => setSoundVolume(parseInt(e.target.value) / 100)}
                  />
                </div>

                {/* Smoothing */}
                <div className="slider-group">
                  <div className="slider-label"><span>Smooth</span> <span>{Math.round(smoothing * 100)}%</span></div>
                  <input
                    type="range" min="0" max="90" step="1"
                    value={smoothing * 100}
                    onChange={(e) => setSmoothing(parseInt(e.target.value) / 100)}
                  />
                </div>

                <div className="dock-divider" />

                {/* Friction - Paper Feel */}
                <div className="slider-group">
                  <div className="slider-label"><span>Paper</span> <span>{Math.round(frictionLevel * 100)}%</span></div>
                  <input
                    type="range" min="0" max="100" step="5"
                    value={frictionLevel * 100}
                    onChange={(e) => setFrictionLevel(parseInt(e.target.value) / 100)}
                  />
                </div>

                <button
                  className={`dock-btn btn-icon ${hapticEnabled ? 'active' : ''}`}
                  onClick={() => setHapticEnabled(!hapticEnabled)}
                  title="Haptic Feedback"
                >
                  📳
                </button>

                <div className="dock-divider" />

                {/* Profiles - Inline, compact */}
                {profiles.slice(0, 4).map(p => (
                  <div
                    key={p.id}
                    className={`profile-chip ${soundProfile === p.id ? 'active' : ''}`}
                    onClick={() => setSoundProfile(p.id)}
                    title={p.label}
                  >
                    <span className="profile-icon">{p.icon}</span>
                  </div>
                ))}
              </div>
            </>
          )}

        </div>
      )}
    </div>
  )
}

export default App
