import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

type Props = {
  onDecode: (text: string) => void
}

// Mobile-first, guided scanner with ROI, torch, and camera switch.
export default function QRScanner({ onDecode }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const roiCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [showFreeze, setShowFreeze] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showHint, setShowHint] = useState(false)

  useEffect(() => {
    let rafId = 0
    let stream: MediaStream | null = null
    let lastTick = 0

    async function listCameras() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        const cams = all.filter((d) => d.kind === 'videoinput')
        setDevices(cams)
      } catch {}
    }

    async function start() {
      setError(null)
      setPermissionDenied(false)
      await listCameras()
      const constraints: MediaStreamConstraints = {
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
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
        // Torch capability
        const track = stream.getVideoTracks()[0]
        const caps: any = track.getCapabilities?.() || {}
        if (caps && typeof caps.torch !== 'undefined') {
          setHasTorch(true)
          // Ensure torch off initially
          try { await (track.applyConstraints as any)({ advanced: [{ torch: false }] }) } catch {}
          setTorchOn(false)
        } else {
          setHasTorch(false)
          setTorchOn(false)
        }
        // Try to request continuous autofocus if supported
        try { await (track.applyConstraints as any)({ advanced: [{ focusMode: 'continuous' }] }) } catch {}
        // Fallback hint after 5s without decode
        setShowHint(false)
        setTimeout(() => { if (active && !showSuccess) setShowHint(true) }, 5000)
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
    }

    function decodeFromROI(video: HTMLVideoElement) {
      const roiCanvas = roiCanvasRef.current
      if (!roiCanvas) return null
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return null
      // ROI: centered square covering ~60% of min dimension
      const side = Math.floor(Math.min(vw, vh) * 0.6)
      const x = Math.floor((vw - side) / 2)
      const y = Math.floor((vh - side) / 2)
      roiCanvas.width = side
      roiCanvas.height = side
      const rctx = roiCanvas.getContext('2d')
      if (!rctx) return null
      rctx.drawImage(video, x, y, side, side, 0, 0, side, side)
      const img = rctx.getImageData(0, 0, side, side)
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
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
      const text = decodeFromROI(video)
      if (text) {
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
      }
    }

    start()
    return () => {
      stop()
    }
  }, [onDecode, deviceId])

  async function toggleTorch() {
    const stream = videoRef.current?.srcObject as MediaStream | null
    if (!stream) return
    const track = stream.getVideoTracks()[0]
    try {
      await (track.applyConstraints as any)({ advanced: [{ torch: !torchOn }] })
      setTorchOn((v) => !v)
    } catch {}
  }

  async function switchCamera() {
    // Pick next available camera
    if (devices.length < 2) return
    const ids = devices.map((d) => d.deviceId)
    const idx = deviceId ? ids.indexOf(deviceId) : -1
    const next = ids[(idx + 1) % ids.length]
    setDeviceId(next)
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const side = Math.min(img.width, img.height)
      canvas.width = side
      canvas.height = side
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // center-crop square then decode
      const sx = Math.floor((img.width - side) / 2)
      const sy = Math.floor((img.height - side) / 2)
      ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side)
      const data = ctx.getImageData(0, 0, side, side)
      const code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' })
      if (code?.data) {
        onDecode(code.data)
      } else {
        setError('Could not read QR, try better lighting or use Manual mode.')
      }
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      setError('Could not load image')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  return (
    <div className="mt-2">
      {/* Video container with overlay */}
      <div className="relative w-full aspect-[3/4] max-h-[60vh] rounded-lg overflow-hidden bg-neutral-100">
        {/* Show captured frame when frozen, else live video */}
        {!showFreeze ? (
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
        ) : (
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        )}
        {/* Darken outside with centered scan box */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-black/40" aria-hidden />
          {/* Scan box: ~70% viewport width, square, thicker border, subtle pulse */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md shadow [width:min(70vw,60vh)] [height:min(70vw,60vh)] bg-transparent border-[3px] border-green-400 animate-pulse" />
        </div>
        {/* Guidance text */}
        <div className="absolute bottom-2 left-0 right-0 px-3 text-center">
          <div className="text-xs text-white">Poravnaj QR v okvir in zadrži 1 sekundo</div>
          <div className="text-[11px] text-white/80">Iščem QR… približaj ali oddalji po potrebi</div>
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
              <span className="text-sm font-medium">QR prepoznan</span>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-2 flex items-center gap-2">
        {hasTorch && (
          <button type="button" className="btn btn-secondary" onClick={toggleTorch}>{torchOn ? 'Torch Off' : 'Torch On'}</button>
        )}
        {devices.length > 1 && (
          <button type="button" className="btn btn-secondary" onClick={switchCamera}>Switch camera</button>
        )}
        <label className="btn btn-secondary">
          Upload QR image
          <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
        </label>
      </div>

      {/* Status & errors */}
      {error && (
        <div className="mt-2 text-xs text-red-500">{error}</div>
      )}
      {permissionDenied && (
        <div className="mt-2 text-xs text-neutral-700 bg-yellow-50 border border-yellow-200 rounded p-2">
          Camera permission denied. Enable camera in browser settings and reload. On iOS Safari: Settings → Safari → Camera → Allow. On Android Chrome: Site settings → Camera → Allow.
        </div>
      )}
      <div className="mt-2 text-xs text-neutral-500">{active ? 'Iščem QR… približaj ali oddalji po potrebi' : 'Camera stopped.'}</div>
      {showHint && (
        <div className="mt-2 text-xs text-neutral-700">Ne gre? Uporabi 'Photo-PDF' ali naloži sliko QR</div>
      )}

      {/* Hidden canvases */}
      <canvas ref={roiCanvasRef} className="hidden" />
    </div>
  )
}
