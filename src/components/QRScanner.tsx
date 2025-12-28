import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

type Props = {
  onDecode: (text: string) => void
}

// Mobile-first, guided scanner with fast ROI loop, auto torch, and auto zoom.
export default function QRScanner({ onDecode }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const roiCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [torchError, setTorchError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [showFreeze, setShowFreeze] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [statusText, setStatusText] = useState('Align QR in frame. Scanning…')
  const ROI_BASE_FRACTION = 0.6
  const [roiFraction, setRoiFraction] = useState(ROI_BASE_FRACTION)
  const [roiUpscaleIndex, setRoiUpscaleIndex] = useState(0) // 0→1.0, 1→1.3, 2→1.6
  const ROI_UPSCALES = [1.0, 1.3, 1.6]
  const [autoTorchFailed, setAutoTorchFailed] = useState(false)
  const [darkHintShown, setDarkHintShown] = useState(false)
  // reading overlay not used in continuous loop
  const [lastDecodeAt, setLastDecodeAt] = useState<number | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [lowLightStart, setLowLightStart] = useState<number | null>(null)
  // avg luminance tracked internally; no exposed state needed

  // (preprocessing helpers removed for lean, fast loop)

  // Preprocessing decoder not used in fast loop

  useEffect(() => {
    let rafId = 0
    let stream: MediaStream | null = null
    let lastTick = 0
    let luminanceTimer: number | null = null

    async function start() {
      setError(null)
      setPermissionDenied(false)
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        setActive(true)
        setStartedAt(performance.now())
        // Torch capability
        const track = stream.getVideoTracks()[0]
        const caps: any = track.getCapabilities?.() || {}
        if (caps && typeof caps.torch !== 'undefined') {
          setHasTorch(true)
          // Default OFF; user can enable via toggle
          setTorchOn(false)
          setTorchError(null)
        } else {
          setHasTorch(false)
          setTorchOn(false)
        }
        // Try to request continuous autofocus if supported
        try { await (track.applyConstraints as any)({ advanced: [{ focusMode: 'continuous' }] }) } catch {}
        // Fallback hint after 10s without decode
        setShowHint(false)
        setTimeout(() => { if (active && !showSuccess) setShowHint(true) }, 10000)
        // Start low-light monitoring every ~500ms
        luminanceTimer = window.setInterval(() => {
          const videoEl = videoRef.current
          const roiCanvas = roiCanvasRef.current
          if (!videoEl || !roiCanvas) return
          const vw = videoEl.videoWidth
          const vh = videoEl.videoHeight
          if (!vw || !vh) return
          const side = Math.floor(Math.min(vw, vh) * roiFraction)
          const x = Math.floor((vw - side) / 2)
          const y = Math.floor((vh - side) / 2)
          roiCanvas.width = side
          roiCanvas.height = side
          const rctx = roiCanvas.getContext('2d')
          if (!rctx) return
          rctx.drawImage(videoEl, x, y, side, side, 0, 0, side, side)
          const img = rctx.getImageData(0, 0, side, side)
          // average luminance (Rec. 601)
          let sum = 0
          const d = img.data
          for (let i = 0; i < d.length; i += 4) {
            const yv = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
            sum += yv
          }
          const avg = sum / (d.length / 4)
          const now = performance.now()
          const THRESH = 35 // empirically dark
          if (avg < THRESH) {
            if (!lowLightStart) setLowLightStart(now)
          } else {
            setLowLightStart(null)
          }
          if (lowLightStart && now - lowLightStart > 1000) {
            // auto-enable torch if supported and not already on
            if (hasTorch && !torchOn) {
              void (async () => {
                try {
                  const track = (videoEl.srcObject as MediaStream).getVideoTracks()[0]
                  await (track.applyConstraints as any)({ advanced: [{ torch: true }] })
                  setTorchOn(true)
                  setStatusText('Torch ON')
                } catch {
                  setAutoTorchFailed(true)
                }
              })()
            } else if (!hasTorch && !darkHintShown) {
              setDarkHintShown(true)
              setStatusText('Too dark — add light')
            }
          }
        }, 500)
        tick()
      } catch (e: any) {
        const name = e?.name || ''
        const msg = e instanceof Error ? e.message : 'Unable to access camera'
        setError(msg)
        setActive(false)
        if (name === 'NotAllowedError' || name === 'SecurityError') setPermissionDenied(true)
      }
    }

    function stop() {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop())
        stream = null
      }
      setActive(false)
      if (rafId) cancelAnimationFrame(rafId)
      if (luminanceTimer) {
        clearInterval(luminanceTimer)
        luminanceTimer = null
      }
    }

    function decodeFromROI(video: HTMLVideoElement) {
      const roiCanvas = roiCanvasRef.current
      if (!roiCanvas) return null
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return null
      // ROI: centered square covering fraction of min dimension
      const side = Math.floor(Math.min(vw, vh) * roiFraction)
      const x = Math.floor((vw - side) / 2)
      const y = Math.floor((vh - side) / 2)
      const upscale = ROI_UPSCALES[roiUpscaleIndex] || 1.0
      roiCanvas.width = Math.floor(side * upscale)
      roiCanvas.height = Math.floor(side * upscale)
      const rctx = roiCanvas.getContext('2d')
      if (!rctx) return null
      rctx.imageSmoothingEnabled = true
      rctx.drawImage(video, x, y, side, side, 0, 0, roiCanvas.width, roiCanvas.height)
      const img = rctx.getImageData(0, 0, roiCanvas.width, roiCanvas.height)
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })
      return code?.data || null
    }

    function tick(ts?: number) {
      rafId = requestAnimationFrame(tick)
      const video = videoRef.current
      if (!video) return
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return
      const now = ts || performance.now()
      // Lightweight progress indicator based on frame cadence
      const delta = Math.min(1, (now - lastTick) / 500)
      lastTick = now
      setProgress((p) => (p + delta > 1 ? 0 : p + delta))
      // Auto-zoom/ROI adjustments after 2s without decode
      if (startedAt && !lastDecodeAt) {
        const elapsed = now - startedAt
        if (elapsed > 2000 && roiUpscaleIndex < 1) {
          setRoiFraction(Math.max(0.5, ROI_BASE_FRACTION - 0.05))
          setRoiUpscaleIndex(1)
        } else if (elapsed > 3500 && roiUpscaleIndex < 2) {
          setRoiFraction(Math.max(0.45, ROI_BASE_FRACTION - 0.1))
          setRoiUpscaleIndex(2)
        }
      }
      const text = decodeFromROI(video)
      if (text) {
        setLastDecodeAt(now)
        // Freeze last frame to canvas
        try {
          const canvas = canvasRef.current
          if (canvas) {
            const w = video.videoWidth
            const h = video.videoHeight
            canvas.width = w
            canvas.height = h
            const ctx = canvas.getContext('2d')
            if (ctx) {
              ctx.drawImage(video, 0, 0, w, h)
              setShowFreeze(true)
            }
          }
        } catch {}
        setShowSuccess(true)
        onDecode(text)
        stop()
        // hide success after 500ms
        window.setTimeout(() => setShowSuccess(false), 500)
      }
    }

    start()
    return () => {
      stop()
    }
  }, [onDecode, roiFraction, roiUpscaleIndex])

  async function toggleTorch() {
    const stream = videoRef.current?.srcObject as MediaStream | null
    if (!stream) return
    const track = stream.getVideoTracks()[0]
    try {
      await (track.applyConstraints as any)({ advanced: [{ torch: !torchOn }] })
      setTorchOn((v) => !v)
      setTorchError(null)
    } catch {
      setTorchError('Unable to toggle torch')
    }
  }

  return (
    <div className="mt-2">
      {/* Video container with overlay */}
      <div className="relative w-full aspect-[3/4] sm:max-h-[60vh] max-h-[50vh] rounded-lg overflow-hidden bg-neutral-100">
        {/* Show captured frame when frozen, else live video */}
        {!showFreeze ? (
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
        ) : (
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        )}
        {/* ROI overlay with darkened outside area */}
        <div className="pointer-events-none absolute inset-0">
          {/* Centered square ROI with outside darkening via large box-shadow */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md [width:min(70vw,60vh)] [height:min(70vw,60vh)] border-[3px] border-green-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
            style={{ transform: `translate(-50%, -50%) scale(${roiFraction / ROI_BASE_FRACTION})` }}
          />
        </div>
        {/* Status text */}
        <div className="absolute bottom-2 left-0 right-0 px-3 text-center">
          <div className="text-sm text-white">{statusText}</div>
        </div>
        {/* Progress indicator */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-24 h-1 bg-white/40 rounded">
          <div className="h-1 rounded bg-white" style={{ width: `${Math.floor(progress * 100)}%` }} />
        </div>
        {/* Success overlay */}
        {showSuccess && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 px-3 py-2 bg-green-600/80 text-white rounded-full">
              <span>✅</span>
              <span className="text-sm font-medium">QR recognized</span>
            </div>
          </div>
        )}
        {/* Tiny torch indicator when auto-enabled */}
        {torchOn && (
          <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 text-white text-xs rounded">Torch ON</div>
        )}
      </div>

      {/* Minimal controls: show torch toggle only if auto failed */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {hasTorch && autoTorchFailed && (
          <button type="button" className="btn btn-secondary" onClick={toggleTorch}>{torchOn ? 'Torch Off' : 'Torch On'}</button>
        )}
      </div>

      {/* Status & errors */}
      {error && (
        <div className="mt-2 text-xs text-red-500">{error}</div>
      )}
      {torchError && (
        <div className="mt-2 text-xs text-red-500">{torchError}</div>
      )}
      {permissionDenied && (
        <div className="mt-2 text-xs text-neutral-700 bg-yellow-50 border border-yellow-200 rounded p-2">
          Camera permission denied. Enable camera in browser settings and reload. On iOS Safari: Settings → Safari → Camera → Allow. On Android Chrome: Site settings → Camera → Allow.
        </div>
      )}
      <div className="mt-2 text-xs text-neutral-500">{active ? 'Auto-scanning. Hold steady.' : 'Camera stopped.'}</div>
      {showHint && (
        <div className="mt-2 text-xs text-neutral-700">Move closer / hold steady / increase light</div>
      )}

      {/* Hidden canvases */}
      <canvas ref={roiCanvasRef} className="hidden" />
    </div>
  )
}
