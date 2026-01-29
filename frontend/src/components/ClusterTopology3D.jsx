import React, { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text, Float, Grid, Stars, Line } from '@react-three/drei'
import * as THREE from 'three'

function ClusterNode({ position, role, name, status }) {
    const meshRef = useRef()
    const isMaster = role === 'master'
    const color = isMaster ? '#3b82f6' : '#a855f7' // Blue vs Purple

    useFrame((state) => {
        if (meshRef.current) {
            const time = state.clock.getElapsedTime()
            meshRef.current.rotation.x = Math.sin(time / 2) * 0.1
            meshRef.current.rotation.y += 0.005
        }
    })

    return (
        <Float speed={2} rotationIntensity={0.2} floatIntensity={0.5}>
            <group position={position}>
                {/* Core Mesh - Glowing Standard Material */}
                <mesh ref={meshRef}>
                    <icosahedronGeometry args={[isMaster ? 0.8 : 0.6, 1]} />
                    <meshStandardMaterial
                        color={color}
                        emissive={color}
                        emissiveIntensity={2}
                        roughness={0.1}
                        metalness={0.5}
                        wireframe={true}
                    />
                </mesh>

                {/* Inner Core (Solid) */}
                <mesh scale={0.5}>
                    <icosahedronGeometry args={[isMaster ? 0.6 : 0.4, 0]} />
                    <meshBasicMaterial color={color} />
                </mesh>

                {/* Status Ring - Only if Ready */}
                {status === 'Ready' && (
                    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -1.2, 0]}>
                        <ringGeometry args={[0.9, 1.0, 32]} />
                        <meshBasicMaterial color="#4ade80" side={THREE.DoubleSide} transparent opacity={0.6} />
                    </mesh>
                )}

                {/* Text Label */}
                <Text
                    position={[0, 1.4, 0]}
                    fontSize={0.25}
                    color="white"
                    anchorX="center"
                    anchorY="middle"
                    outlineWidth={0.02}
                    outlineColor="black"
                >
                    {name}
                </Text>
                <Text
                    position={[0, 1.1, 0]}
                    fontSize={0.15}
                    color={color}
                    anchorX="center"
                    anchorY="middle"
                >
                    {role.toUpperCase()}
                </Text>
            </group>
        </Float>
    )
}

function TrafficPulse({ start, end, onComplete }) {
    const meshRef = useRef()
    const curve = useMemo(() => {
        const mid = new THREE.Vector3().addVectors(new THREE.Vector3(...start), new THREE.Vector3(...end)).multiplyScalar(0.5)
        mid.y += 1.5 // Arc upward
        return new THREE.CatmullRomCurve3([
            new THREE.Vector3(...start),
            mid,
            new THREE.Vector3(...end)
        ])
    }, [start, end])

    useFrame((state) => {
        if (!meshRef.current) return
        const t = (state.clock.getElapsedTime() * 0.5) % 1
        const position = curve.getPoint(t)
        meshRef.current.position.copy(position)

        // If we reach the end, we could trigger onComplete, 
        // but for simplicity in this "Wow" feature, we'll let it loop or we'll manage a pool.
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

    // Calculate worker positions and map them by IP or index for pulse lookups
    const nodePositionMap = useMemo(() => {
        const map = new Map()
        map.set('master', masterPos)

        workerNodes.forEach((node, i) => {
            const angle = (i / workerNodes.length) * Math.PI * 2
            const pos = [
                Math.cos(angle) * radius,
                0.5,
                Math.sin(angle) * radius
            ]
            map.set(node.hostname || `worker-${i}`, pos)
            map.set(node.ip, pos)
        })
        return map
    }, [workerNodes])

    const workerPositions = workerNodes.map((node, i) => nodePositionMap.get(node.hostname || `worker-${i}`))

    return (
        <>
            {/* Lighting Setup */}
            <ambientLight intensity={1.5} />
            <pointLight position={[10, 10, 10]} intensity={2} />
            <pointLight position={[-10, -10, -10]} intensity={1} color="blue" />

            {/* Environment */}
            <Stars radius={60} depth={50} count={2000} factor={4} saturation={0} fade speed={0.5} />
            <Grid infiniteGrid fadeDistance={25} sectionColor="#4f4f4f" cellColor="#4f4f4f" />

            {/* Master Node */}
            {masterNodes.map((node, i) => (
                <ClusterNode
                    key={`master-${i}`}
                    position={masterPos}
                    role="master"
                    name={node.name || 'Master'}
                    status={node.status}
                />
            ))}

            {/* Worker Nodes & Connections */}
            {workerNodes.map((node, i) => {
                const pos = nodePositionMap.get(node.hostname || `worker-${i}`)
                return (
                    <React.Fragment key={`worker-${node.ip || i}`}>
                        <ClusterNode
                            position={pos}
                            role="worker"
                            name={node.name || `Worker-${i}`}
                            status={node.status}
                        />

                        {/* Connection Line */}
                        <Line
                            points={[masterPos, pos]}
                            color="#a855f7"
                            lineWidth={1}
                            transparent
                            opacity={0.3}
                        />
                    </React.Fragment>
                )
            })}

            {/* Render Active Traffic Pulses */}
            {pulses.map(pulse => (
                <TrafficPulse
                    key={pulse.id}
                    start={nodePositionMap.get(pulse.from) || masterPos}
                    end={nodePositionMap.get(pulse.to) || masterPos}
                />
            ))}

            <OrbitControls
                autoRotate
                autoRotateSpeed={0.5}
                enablePan={false}
                minPolarAngle={0}
                maxPolarAngle={Math.PI / 2.1}
            />
        </>
    )
}

export default function ClusterTopology3D({ clusterId, clusterInfo, height = "500px" }) {
    const hasData = clusterInfo?.nodes && clusterInfo.nodes.length > 0;
    const [pulses, setPulses] = React.useState([])

    React.useEffect(() => {
        if (!clusterId) return

        const token = localStorage.getItem('token')
        const ws = new WebSocket(`ws://${window.location.hostname}:3000/ws/traffic/${clusterId}?token=${token}`)

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data)
            if (data.type === 'traffic-pulse') {
                const pulseId = Math.random().toString(36).substr(2, 9)
                setPulses(prev => [...prev, { ...data, id: pulseId }])

                // Remove pulse after animation (e.g., 2 seconds)
                setTimeout(() => {
                    setPulses(prev => prev.filter(p => p.id !== pulseId))
                }, 4000)
            }
        }

        return () => ws.close()
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
            <div className="absolute top-4 left-4 pointer-events-none z-10">
                <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
                    <span className="text-xs font-mono text-green-400 uppercase tracking-widest">Live Topology & Traffic</span>
                </div>
            </div>

            <Canvas camera={{ position: [0, 4, 8], fov: 60 }} onCreated={(state) => state.gl.setClearColor('#000000', 0)}>
                <Scene clusterInfo={clusterInfo} pulses={pulses} />
            </Canvas>
        </div>
    )
}
