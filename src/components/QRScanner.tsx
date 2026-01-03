import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

type Props = {
  onDecode: (text: string) => void
}

export default function QRScanner({ onDecode }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animationRef = useRef<number>()
  const [isActive, setIsActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const hasDecodedRef = useRef(false)

  useEffect(() => {
    let stream: MediaStream | null = null

    async function start() {
      try {
        setError(null)
        setPermissionDenied(false)
        hasDecodedRef.current = false
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        setIsActive(true)
        animationRef.current = requestAnimationFrame(scanFrame)
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setPermissionDenied(true)
        }
        const message = err instanceof Error ? err.message : 'Unable to access camera'
        setError(message)
        setIsActive(false)
      }
    }

    function stop() {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = undefined
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
        stream = null
      }
      setIsActive(false)
    }

    function scanFrame() {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) {
        animationRef.current = requestAnimationFrame(scanFrame)
        return
      }
      if (video.readyState < video.HAVE_ENOUGH_DATA) {
        animationRef.current = requestAnimationFrame(scanFrame)
        return
      }
      const { videoWidth, videoHeight } = video
      if (!videoWidth || !videoHeight) {
        animationRef.current = requestAnimationFrame(scanFrame)
        return
      }
      canvas.width = videoWidth
      canvas.height = videoHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        animationRef.current = requestAnimationFrame(scanFrame)
        return
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(image.data, image.width, image.height)
      if (code?.data && !hasDecodedRef.current) {
        hasDecodedRef.current = true
        onDecode(code.data)
        stop()
        return
      }
      animationRef.current = requestAnimationFrame(scanFrame)
    }

    start()
    return () => {
      stop()
    }
  }, [onDecode])

  return (
    <div className="space-y-2">
      <div className="relative w-full aspect-[3/4] overflow-hidden rounded-lg bg-neutral-900/20">
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {permissionDenied && (
        <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded p-2">
          Camera permission denied. Enable camera access in your browser settings and reload this page.
        </p>
      )}
      <p className="text-xs text-neutral-500">{isActive ? 'Point the QR code at the camera.' : 'Camera inactive.'}</p>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  )
}
