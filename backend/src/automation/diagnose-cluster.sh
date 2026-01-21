#!/bin/bash

echo "========================================="
echo "Cluster Configuration Diagnostic"
echo "========================================="

echo ""
echo "1. Checking kubeadm-config ConfigMap..."
kubectl -n kube-system get cm kubeadm-config -o yaml

echo ""
echo "2. Extracting ClusterConfiguration..."
kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}'

echo ""
echo "3. Checking for controlPlaneEndpoint..."
if kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | grep -q "controlPlaneEndpoint"; then
    echo "✓ controlPlaneEndpoint FOUND"
    kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | grep "controlPlaneEndpoint"
else
    echo "❌ controlPlaneEndpoint NOT FOUND"
fi

echo ""
echo "4. Current cluster nodes..."
kubectl get nodes -o wide

echo ""
echo "========================================="
