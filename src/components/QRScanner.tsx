import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

export default function QRScanner({ onDecode }: { onDecode: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let rafId = 0
    let stream: MediaStream | null = null

    async function start() {
      setError(null)
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        setActive(true)
        tick()
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unable to access camera'
        setError(msg)
        setActive(false)
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

    function tick() {
      rafId = requestAnimationFrame(tick)
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
      if (code && code.data) {
        onDecode(code.data)
        stop()
      }
    }

    start()
    return () => {
      stop()
    }
  }, [onDecode])

  return (
    <div className="mt-2">
      {error && <div className="text-sm text-red-500 mb-2">{error}</div>}
      <video ref={videoRef} className="w-full rounded border border-neutral-300" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />
      <div className="mt-2 text-xs text-neutral-500">{active ? 'Scanning… point camera at QR code.' : 'Camera stopped.'}</div>
    </div>
  )
}
