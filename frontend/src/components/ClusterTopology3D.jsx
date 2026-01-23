import React, { useRef, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Text, Float, Grid, Stars } from '@react-three/drei'
import * as THREE from 'three'

function ConnectionLine({ start, end, color }) {
    const points = useMemo(() => [start, end], [start, end])
    const lineRef = useRef()

    useFrame((state) => {
        if (lineRef.current) {
            lineRef.current.material.dashOffset -= 0.05
        }
    })

    return (
        <line>
            <bufferGeometry>
                <float32BufferAttribute attach="attributes-position" count={2} array={new Float32Array([...start, ...end])} itemSize={3} />
            </bufferGeometry>
            <lineDashedMaterial
                ref={lineRef}
                attach="material"
                color={color}
                dashSize={0.2}
                gapSize={0.1}
                opacity={0.5}
                transparent
                linewidth={1}
            />
        </line>
    )
}

function ClusterNode({ position, role, name, status }) {
    const meshRef = useRef()
    const isMaster = role === 'master'
    const color = isMaster ? '#3b82f6' : '#a855f7' // Blue vs Purple

    useFrame((state) => {
        const time = state.clock.getElapsedTime()
        meshRef.current.rotation.x = Math.sin(time / 2) * 0.2
        meshRef.current.rotation.y += 0.01
    })

    return (
        <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
            <group position={position}>
                {/* Core Mesh - Using Standard Material for better visibility reliability */}
                <mesh ref={meshRef}>
                    <icosahedronGeometry args={[isMaster ? 0.8 : 0.5, 0]} />
                    <meshStandardMaterial
                        color={color}
                        roughness={0.2}
                        metalness={0.8}
                        emissive={color}
                        emissiveIntensity={2}
                        wireframe={true}
                    />
                </mesh>

                {/* Inner Core */}
                <mesh scale={0.5}>
                    <icosahedronGeometry args={[isMaster ? 0.6 : 0.3, 1]} />
                    <meshBasicMaterial color="white" wireframe />
                </mesh>

                {/* Status Ring */}
                {status === 'Ready' && (
                    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -1, 0]}>
                        <ringGeometry args={[0.8, 0.9, 32]} />
                        <meshBasicMaterial color="#4ade80" side={THREE.DoubleSide} transparent opacity={0.5} />
                    </mesh>
                )}

                {/* Label */}
                <Text
                    position={[0, 1.3, 0]}
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
                    position={[0, 0.9, 0]}
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

function Scene({ clusterInfo }) {
    const masterNodes = clusterInfo?.nodes?.filter(n => n.role === 'master') || []
    const workerNodes = clusterInfo?.nodes?.filter(n => n.role === 'worker') || []

    // Calculate positions
    // Master in center
    const masterPos = [0, 1, 0]

    // Workers in circle around master
    const radius = 4
    const workerPositions = workerNodes.map((_, i) => {
        const angle = (i / workerNodes.length) * Math.PI * 2
        return [
            Math.cos(angle) * radius,
            1, // Slightly higher
            Math.sin(angle) * radius
        ]
    })

    return (
        <>
            <ambientLight intensity={1.5} />
            <pointLight position={[10, 10, 10]} intensity={2} />
            <pointLight position={[-10, -10, -10]} intensity={1} color="blue" />

            <Stars radius={50} depth={50} count={3000} factor={4} saturation={0} fade speed={1} />

            {/* Grid with explicit colors */}
            <Grid infiniteGrid fadeDistance={30} sectionColor="#4f4f4f" cellColor="#4f4f4f" />

            {/* Master Node(s) */}
            {masterNodes[0] && (
                <ClusterNode
                    position={masterPos}
                    role="master"
                    name={masterNodes[0].name || 'Master'}
                    status={masterNodes[0].status}
                />
            )}

            {/* Worker Nodes */}
            {workerNodes.map((node, i) => (
                <React.Fragment key={i}>
                    <ClusterNode
                        position={workerPositions[i]}
                        role="worker"
                        name={node.name || `Worker-${i + 1}`}
                        status={node.status}
                    />
                    {/* Connection Line */}
                    <ConnectionLine
                        start={masterPos}
                        end={workerPositions[i]}
                        color="#a855f7"
                    />
                </React.Fragment>
            ))}

            <OrbitControls
                enablePan={false}
                minPolarAngle={0}
                maxPolarAngle={Math.PI / 2.2}
                autoRotate
                autoRotateSpeed={0.8}
            />
        </>
    )
}

export default function ClusterTopology3D({ clusterInfo, height = "500px" }) {
    const hasData = clusterInfo?.nodes && clusterInfo.nodes.length > 0;

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
        <div style={{ height, width: '100%', background: 'radial-gradient(circle at center, #1e1e24 0%, #000000 100%)', borderRadius: '1rem', overflow: 'hidden', position: 'relative' }}>
            <Canvas camera={{ position: [6, 4, 8], fov: 45 }}>
                <color attach="background" args={['#050510']} />
                <fog attach="fog" args={['#050510', 8, 30]} />
                <Scene clusterInfo={clusterInfo} />
            </Canvas>

            <div className="absolute top-4 left-4 pointer-events-none">
                <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
                    <span className="text-xs font-mono text-green-400 uppercase tracking-widest">Live Topology</span>
                </div>
            </div>
        </div>
    )
}
