import { useState, useRef, useEffect } from 'react';
import { NuanceCanvas, type NuanceCanvasHandle } from './components/NuanceCanvas';
import { type SoundProfile } from './core/SoundEngine';
import { type GridType } from './core/geminiInkRenderer';
import { createShare } from './core/share';
import { Player } from './components/Player';
import './App.css';

function App() {
  const canvasRef = useRef<NuanceCanvasHandle>(null);
  const [brushSize, setBrushSize] = useState(8);
  const [penOnly] = useState(true); // Default to Pen Mode
  const [soundProfile, setSoundProfile] = useState<SoundProfile>('pencil');
  const [soundVolume, setSoundVolume] = useState(0.5);
  const [strokeColor, setStrokeColor] = useState('#333333');
  const [hapticEnabled, setHapticEnabled] = useState(false); // Default OFF

  // v1.8.0: Unified Surface Feel (replaces smoothing + friction)
  const [surfaceTexture, setSurfaceTexture] = useState(0.4);
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(true);
  const [rawMode, setRawMode] = useState(false);

  // v2.0: Color picker + Selection tool
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [toolMode, setToolMode] = useState<'draw' | 'select'>('draw');
  const [selectedCount, setSelectedCount] = useState(0);
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // v2.1: Grid type selection
  const [gridType, setGridType] = useState<GridType>('square');

  // v2.5: Fullscreen
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    // Check for embed mode
    const params = new URLSearchParams(window.location.search);
    if (params.get('embed') === 'true') {
      setIsEmbedMode(true);
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  const path = window.location.pathname;
  if (path.startsWith('/s/')) {
    const shareId = path.split('/s/')[1];
    if (shareId) {
      return <Player shareId={shareId} />;
    }
  }

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

  const handleShareLink = async () => {
    if (!canvasRef.current) return;
    try {
      const drawing = canvasRef.current.exportStrokes();
      if (!drawing) return;
      const { url } = await createShare(drawing);

      if (typeof navigator.share === 'function') {
        await navigator.share({
          title: 'Nuance Share',
          text: 'View my Nuance drawing',
          url
        });
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        alert('✅ Link copied!');
      } else {
        alert(url);
      }
    } catch (err) {
      alert(`Share failed: ${(err as Error).message}`);
    }
  };

  const sizes = [4, 8, 12, 16];
  const primaryColors = ['#333333', '#cc3300', '#ff9900', '#009944', '#0055cc', '#ffffff'];
  const extendedColors = [
    '#000000', '#333333', '#666666', '#999999', '#cccccc', '#ffffff',
    '#cc3300', '#ff6600', '#ff9900', '#ffcc00', '#ff3366', '#cc0066',
    '#0055cc', '#0099ff', '#00ccff', '#663399', '#9933cc', '#3366ff',
    '#009944', '#33cc33', '#66ff66', '#006633', '#339966', '#00cc99',
    '#8B4513', '#D2691E', '#DEB887', '#FFB6C1', '#E6E6FA', '#F0E68C',
  ];
  const networkUrl = "http://192.168.1.107:5173";

  const gridOptions: { id: GridType, label: string, icon: string }[] = [
    { id: 'none', label: 'None', icon: '⬜' },
    { id: 'square', label: 'Grid', icon: '▦' },
    { id: 'dot', label: 'Dots', icon: '⁘' },
    { id: 'ruled', label: 'Ruled', icon: '☰' },
    { id: 'isometric', label: 'Iso', icon: '△' },
    { id: 'graph', label: 'Graph', icon: '▥' },
    { id: 'hex', label: 'Hex', icon: '⬡' },
  ];

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
      {/* Version Label */}
      <div style={{
        position: 'fixed', top: 8, right: 12,
        background: 'rgba(0,0,0,0.3)', color: 'white',
        padding: '3px 10px', borderRadius: '12px',
        fontSize: '10px', fontWeight: 600,
        pointerEvents: 'none', zIndex: 9999,
        fontFamily: 'monospace'
      }}>
        v2.5.0
      </div>
      <NuanceCanvas
        ref={canvasRef}
        brushSize={brushSize}
        penOnly={penOnly}
        soundProfile={soundProfile}
        soundVolume={soundVolume}
        strokeColor={strokeColor}
        smoothing={0.7 - surfaceTexture * 0.5}
        hapticEnabled={hapticEnabled}
        surfaceTexture={surfaceTexture}
        onSelectionChange={(count) => setSelectedCount(count)}
        multiSelectMode={multiSelectMode}
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

          {/* Color Picker Popup */}
          {showColorPicker && (
            <div className="color-picker-popup" onClick={(e) => e.stopPropagation()}>
              <div className="color-grid">
                {extendedColors.map(c => (
                  <div
                    key={c}
                    className={`color-swatch ${strokeColor === c ? 'active' : ''}`}
                    style={{ backgroundColor: c }}
                    onClick={() => {
                      setStrokeColor(c);
                      setShowColorPicker(false);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Toolbar Content - Collapsible */}
          {toolbarExpanded && (
            <>
              {/* Selection Actions Bar - Only when strokes selected */}
              {toolMode === 'select' && selectedCount > 0 && (
                <div className="dock-row selection-bar">
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#007AFF' }}>
                    {selectedCount} selected
                  </span>

                  <div className="dock-divider" />

                  {/* Delete Selected */}
                  <button
                    className="dock-btn btn-icon"
                    onClick={() => {
                      canvasRef.current?.deleteSelected();
                      setSelectedCount(0);
                    }}
                    title="Delete Selected"
                    style={{ color: '#ff3b30' }}
                  >
                    🗑️
                  </button>

                  {/* Recolor Selected */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {primaryColors.map(c => (
                      <div
                        key={`sel-${c}`}
                        className="color-swatch"
                        style={{ backgroundColor: c, width: '22px', height: '22px' }}
                        onClick={() => {
                          canvasRef.current?.changeSelectedColor(c);
                        }}
                      />
                    ))}
                  </div>

                  <div className="dock-divider" />

                  {/* Multi-select toggle */}
                  <button
                    className={`dock-btn btn-icon ${multiSelectMode ? 'active' : ''}`}
                    onClick={() => setMultiSelectMode(!multiSelectMode)}
                    title={multiSelectMode ? 'Multi-select ON' : 'Multi-select OFF'}
                    style={{ fontSize: '16px', fontWeight: 700 }}
                  >
                    +
                  </button>

                  {/* Deselect All */}
                  <button
                    className="dock-btn btn-icon"
                    onClick={() => {
                      canvasRef.current?.clearSelection();
                      setSelectedCount(0);
                    }}
                    title="Deselect All"
                    style={{ fontSize: '14px' }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Row 1: Mode + Tools + Colors + Sizes */}
              <div className="dock-row">
                {/* Draw/Select Mode Toggle */}
                <button
                  className={`dock-btn btn-icon ${toolMode === 'draw' ? 'active' : ''}`}
                  onClick={() => {
                    setToolMode('draw');
                    canvasRef.current?.setToolMode('draw');
                    setSelectedCount(0);
                  }}
                  title="Draw"
                >
                  ✏️
                </button>
                <button
                  className={`dock-btn btn-icon ${toolMode === 'select' ? 'active' : ''}`}
                  onClick={() => {
                    setToolMode('select');
                    canvasRef.current?.setToolMode('select');
                  }}
                  title="Select"
                >
                  👆
                </button>

                <div className="dock-divider" />

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
                <button className="dock-btn btn-primary" onClick={handleShareLink}>
                  Share Link
                </button>
                <button
                  className={`dock-btn btn-icon ${isFullscreen ? 'active' : ''}`}
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                  style={{ fontSize: '16px' }}
                >
                  {isFullscreen ? '⊡' : '⛶'}
                </button>

                <div className="dock-divider" />

                {/* Colors - Primary + More button */}
                <div style={{ display: 'flex', gap: '6px' }}>
                  {primaryColors.map(c => (
                    <div
                      key={c}
                      className={`color-swatch ${strokeColor === c ? 'active' : ''}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setStrokeColor(c)}
                    />
                  ))}
                  <div
                    className={`color-swatch ${showColorPicker ? 'active' : ''}`}
                    style={{
                      background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                      border: showColorPicker ? '2px solid #007AFF' : '2px solid transparent'
                    }}
                    onClick={() => setShowColorPicker(!showColorPicker)}
                    title="More colors"
                  />
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

                <div className="dock-divider" />

                {/* Surface Feel */}
                <div className="slider-group" style={{ minWidth: '120px' }}>
                  <div className="slider-label">
                    <span>🧊</span>
                    <span style={{ flex: 1, textAlign: 'center', fontSize: '9px' }}>Surface</span>
                    <span>🪨</span>
                  </div>
                  <input
                    type="range" min="0" max="100" step="5"
                    value={surfaceTexture * 100}
                    onChange={(e) => {
                      const newTexture = parseInt(e.target.value) / 100;
                      setSurfaceTexture(newTexture);
                      canvasRef.current?.setSurfaceTexture(newTexture);
                    }}
                  />
                </div>

                <button
                  className={`dock-btn btn-icon ${hapticEnabled ? 'active' : ''}`}
                  onClick={() => setHapticEnabled(!hapticEnabled)}
                  title="Haptic Feedback"
                >
                  📳
                </button>

                <button
                  className={`dock-btn btn-icon ${rawMode ? 'active' : ''}`}
                  onClick={() => {
                    const newMode = !rawMode;
                    setRawMode(newMode);
                    canvasRef.current?.setRawMode(newMode);
                  }}
                  style={rawMode ? { background: '#ff3b30', color: 'white' } : {}}
                >
                  ⚡
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

                <div className="dock-divider" />

                {/* Grid Type Selector */}
                {gridOptions.map(g => (
                  <div
                    key={g.id}
                    className={`grid-chip ${gridType === g.id ? 'active' : ''}`}
                    onClick={() => {
                      setGridType(g.id);
                      canvasRef.current?.setGridType(g.id);
                    }}
                    title={g.label}
                  >
                    <span className="grid-icon">{g.icon}</span>
                    <span className="grid-label">{g.label}</span>
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
