import React, { useRef, useMemo, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text, Float, Grid, Stars, Line, Html } from '@react-three/drei'
import * as THREE from 'three'

// Status → visual state
function nodeVisual(role, status) {
    const isMaster = role === 'master'
    const s = (status || '').toLowerCase()
    const down = s && s !== 'ready' && s !== 'pending' && s !== 'running'
    const pending = s === 'pending'
    if (down)    return { color: '#ef4444', label: 'DOWN', ring: '#ef4444', pulse: true }   // red
    if (pending) return { color: '#f59e0b', label: 'PENDING', ring: '#f59e0b', pulse: true } // amber
    return { color: isMaster ? '#3b82f6' : '#a855f7', label: 'READY', ring: '#4ade80', pulse: false } // healthy
}

function ClusterNode({ position, role, name, status, ip }) {
    const meshRef = useRef()
    const [hovered, setHovered] = useState(false)
    const isMaster = role === 'master'
    const v = nodeVisual(role, status)

    useFrame((state) => {
        if (!meshRef.current) return
        const time = state.clock.getElapsedTime()
        meshRef.current.rotation.y += 0.005
        // Down/pending nodes pulse to grab attention
        if (v.pulse) {
            const p = 1 + Math.sin(time * 4) * 0.12
            meshRef.current.scale.setScalar(p)
        } else {
            meshRef.current.scale.setScalar(hovered ? 1.15 : 1)
        }
    })

    return (
        <Float speed={v.pulse ? 4 : 2} rotationIntensity={0.2} floatIntensity={v.pulse ? 1 : 0.5}>
            <group position={position}>
                <mesh
                    ref={meshRef}
                    onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
                    onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto' }}
                >
                    <icosahedronGeometry args={[isMaster ? 0.8 : 0.6, 1]} />
                    <meshStandardMaterial
                        color={v.color}
                        emissive={v.color}
                        emissiveIntensity={v.pulse ? 3 : 2}
                        roughness={0.1}
                        metalness={0.5}
                        wireframe={true}
                    />
                </mesh>

                <mesh scale={0.5}>
                    <icosahedronGeometry args={[isMaster ? 0.6 : 0.4, 0]} />
                    <meshBasicMaterial color={v.color} />
                </mesh>

                {/* Status ring */}
                <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -1.2, 0]}>
                    <ringGeometry args={[0.9, 1.0, 32]} />
                    <meshBasicMaterial color={v.ring} side={THREE.DoubleSide} transparent opacity={0.7} />
                </mesh>

                {/* Warning glow for down nodes */}
                {v.pulse && <pointLight distance={4} intensity={3} color={v.color} />}

                {/* Labels */}
                <Text position={[0, 1.5, 0]} fontSize={0.25} color="white" anchorX="center" anchorY="middle" outlineWidth={0.02} outlineColor="black">
                    {name}
                </Text>
                <Text position={[0, 1.18, 0]} fontSize={0.14} color={v.color} anchorX="center" anchorY="middle">
                    {role.toUpperCase()} · {v.label}
                </Text>

                {/* Hover tooltip */}
                {hovered && (
                    <Html position={[0, -1.6, 0]} center distanceFactor={10}>
                        <div style={{
                            background: 'rgba(10,10,15,0.95)', border: `1px solid ${v.color}`, borderRadius: 10,
                            padding: '8px 12px', color: '#fff', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap',
                            boxShadow: `0 0 20px ${v.color}55`
                        }}>
                            <div style={{ fontWeight: 800 }}>{name}</div>
                            <div style={{ color: '#94a3b8' }}>{ip || 'n/a'}</div>
                            <div style={{ color: v.color, fontWeight: 700 }}>{role} · {v.label}</div>
                        </div>
                    </Html>
                )}
            </group>
        </Float>
    )
}

function TrafficPulse({ start, end }) {
    const meshRef = useRef()
    const curve = useMemo(() => {
        const mid = new THREE.Vector3().addVectors(new THREE.Vector3(...start), new THREE.Vector3(...end)).multiplyScalar(0.5)
        mid.y += 1.5
        return new THREE.CatmullRomCurve3([new THREE.Vector3(...start), mid, new THREE.Vector3(...end)])
    }, [start, end])

    useFrame((state) => {
        if (!meshRef.current) return
        const t = (state.clock.getElapsedTime() * 0.5) % 1
        meshRef.current.position.copy(curve.getPoint(t))
    })

    return (
        <mesh ref={meshRef}>
            <sphereGeometry args={[0.1, 8, 8]} />
            <meshBasicMaterial color="#60a5fa" transparent opacity={0.8} />
            <pointLight distance={2} intensity={2} color="#60a5fa" />
        </mesh>
    )
}

function Scene({ clusterInfo, pulses = [] }) {
    const masterNodes = clusterInfo?.nodes?.filter(n => n.role === 'master') || []
    const workerNodes = clusterInfo?.nodes?.filter(n => n.role === 'worker') || []
    const masterPos = [0, 1, 0]
    const radius = 4

    const nodePositionMap = useMemo(() => {
        const map = new Map()
        map.set('master', masterPos)
        workerNodes.forEach((node, i) => {
            const angle = (i / Math.max(workerNodes.length, 1)) * Math.PI * 2
            const pos = [Math.cos(angle) * radius, 0.5, Math.sin(angle) * radius]
            map.set(node.hostname || `worker-${i}`, pos)
            map.set(node.ip, pos)
        })
        return map
    }, [workerNodes])

    const isDown = (s) => { const x = (s || '').toLowerCase(); return x && x !== 'ready' && x !== 'pending' && x !== 'running' }

    return (
        <>
            <ambientLight intensity={1.5} />
            <pointLight position={[10, 10, 10]} intensity={2} />
            <pointLight position={[-10, -10, -10]} intensity={1} color="blue" />
            <Stars radius={60} depth={50} count={2000} factor={4} saturation={0} fade speed={0.5} />
            <Grid infiniteGrid fadeDistance={25} sectionColor="#4f4f4f" cellColor="#4f4f4f" />

            {masterNodes.map((node, i) => (
                <ClusterNode key={`master-${i}`} position={masterPos} role="master" name={node.name || node.hostname || 'Master'} status={node.status} ip={node.ip} />
            ))}

            {workerNodes.map((node, i) => {
                const pos = nodePositionMap.get(node.hostname || `worker-${i}`)
                const down = isDown(node.status)
                return (
                    <React.Fragment key={`worker-${node.ip || i}`}>
                        <ClusterNode position={pos} role="worker" name={node.name || node.hostname || `Worker-${i}`} status={node.status} ip={node.ip} />
                        {/* Connection line turns red if the node is down */}
                        <Line
                            points={[masterPos, pos]}
                            color={down ? '#ef4444' : '#a855f7'}
                            lineWidth={down ? 2 : 1}
                            transparent
                            opacity={down ? 0.7 : 0.3}
                            dashed={down}
                            dashSize={0.3}
                            gapSize={0.15}
                        />
                    </React.Fragment>
                )
            })}

            {pulses.map(pulse => (
                <TrafficPulse key={pulse.id} start={nodePositionMap.get(pulse.from) || masterPos} end={nodePositionMap.get(pulse.to) || masterPos} />
            ))}

            <OrbitControls autoRotate autoRotateSpeed={0.4} enablePan enableZoom minDistance={4} maxDistance={20} minPolarAngle={0} maxPolarAngle={Math.PI / 2.1} />
        </>
    )
}

export default function ClusterTopology3D({ clusterId, clusterInfo, height = "500px" }) {
    const hasData = clusterInfo?.nodes && clusterInfo.nodes.length > 0
    const [pulses, setPulses] = React.useState([])

    const nodes = clusterInfo?.nodes || []
    const downCount = nodes.filter(n => { const s = (n.status || '').toLowerCase(); return s && s !== 'ready' && s !== 'pending' && s !== 'running' }).length
    const readyCount = nodes.length - downCount

    React.useEffect(() => {
        if (!clusterId) return
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        let ws
        try {
            ws = new WebSocket(`${protocol}//${window.location.host}/ws/traffic/${clusterId}`)
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data)
                if (data.type === 'traffic-pulse') {
                    const pulseId = Math.random().toString(36).substr(2, 9)
                    setPulses(prev => [...prev, { ...data, id: pulseId }])
                    setTimeout(() => setPulses(prev => prev.filter(p => p.id !== pulseId)), 4000)
                }
            }
        } catch (_) {}
        return () => { try { ws?.close() } catch (_) {} }
    }, [clusterId])

    if (!hasData) {
        return (
            <div style={{ height, width: '100%', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '1rem', color: 'white' }}>
                <div className="text-center">
                    <p className="font-bold">Waiting for Cluster Data...</p>
                    <p className="text-xs text-slate-500">Node telemetry not yet available.</p>
                </div>
            </div>
        )
    }

    return (
        <div style={{ height, width: '100%', background: 'radial-gradient(circle at center, #1b1b1f 0%, #000000 100%)', borderRadius: '1rem', overflow: 'hidden', position: 'relative' }}>
            {/* Live status header */}
            <div className="absolute top-4 left-4 pointer-events-none z-10">
                <div className="flex items-center space-x-2">
                    <div className={`w-2 h-2 rounded-full ${downCount > 0 ? 'bg-red-500' : 'bg-green-400'} animate-pulse`}></div>
                    <span className={`text-xs font-mono uppercase tracking-widest ${downCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {downCount > 0 ? `${downCount} node(s) down` : 'All nodes healthy'}
                    </span>
                </div>
            </div>

            {/* Legend */}
            <div className="absolute top-4 right-4 pointer-events-none z-10 flex flex-col gap-1.5 bg-black/40 backdrop-blur-md rounded-xl px-3 py-2 border border-white/10">
                <LegendItem color="#3b82f6" label="Master (Ready)" />
                <LegendItem color="#a855f7" label="Worker (Ready)" />
                <LegendItem color="#ef4444" label="Down / NotReady" />
                <LegendItem color="#f59e0b" label="Pending" />
            </div>

            {/* Node counters */}
            <div className="absolute bottom-4 left-4 pointer-events-none z-10 flex gap-3">
                <div className="bg-black/40 backdrop-blur-md rounded-xl px-3 py-1.5 border border-emerald-500/20">
                    <span className="text-emerald-400 text-xs font-black">{readyCount}</span>
                    <span className="text-slate-500 text-[10px] ml-1 uppercase">Ready</span>
                </div>
                {downCount > 0 && (
                    <div className="bg-black/40 backdrop-blur-md rounded-xl px-3 py-1.5 border border-red-500/20 animate-pulse">
                        <span className="text-red-400 text-xs font-black">{downCount}</span>
                        <span className="text-slate-500 text-[10px] ml-1 uppercase">Down</span>
                    </div>
                )}
            </div>

            <Canvas camera={{ position: [0, 4, 8], fov: 60 }} onCreated={(state) => state.gl.setClearColor('#000000', 0)}>
                <Scene clusterInfo={clusterInfo} pulses={pulses} />
            </Canvas>
        </div>
    )
}

function LegendItem({ color, label }) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }}></span>
            <span className="text-[10px] font-bold text-slate-300">{label}</span>
        </div>
    )
}
