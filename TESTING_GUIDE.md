# KubeEZ - Quick Test Guide

## 🧪 Test 1: Fresh Installation (5 minutes)

### Step-by-Step:

1. **Open Browser**
   - Go to `http://localhost:5173`
   - Press `Ctrl+Shift+R` (hard refresh)
   - Open Console (F12)

2. **Start New Installation**
   - Click "New Installation" button
   - Should navigate to `/install`

3. **Step 1: Cluster Config**
   - Enter cluster name: `test-cluster`
   - Select K8s version: `1.28.0`
   - Select network: `flannel`
   - Click "Continue"

4. **Step 2: Add Master Node**
   - Enter IP: `192.168.1.10` (your master IP)
   - Username: `root`
   - Password: `your-password`
   - Click "Kickstart Diagnostics"
   
   **Expected:**
   - Button should show "Scanning..."
   - Console should show: `[NodeVerification] handleVerify called`
   - After 5-10 seconds: Status should show "READY" or "READY-WITH-WARNINGS"
   
   **If button is disabled:**
   - Check console for: `[NodeVerification] Missing required fields`
   - Verify IP and username are filled

5. **Add Worker (Optional)**
   - Click "Add Worker Node"
   - Fill details
   - Verify

6. **Continue to Add-ons**
   - Click "Continue"
   - Should go to Step 3

7. **Step 3: Select Add-ons**
   - Check "Dashboard"
   - Click "Continue"

8. **Step 4: Review**
   - Verify all details are correct
   - Click "Launch Kubernetes Installation"

9. **Monitor Dashboard**
   - Should navigate to `/dashboard/:id`
   - Watch logs stream
   - Progress bar should update
   - Wait for "✅ Cluster Installation Complete!"

10. **After Completion**
    - Click "Download Kubeconfig"
    - Click "Scale This Cluster" (should go to scale wizard)
    - Click "Go Home" (should go to home page)

---

## 🔄 Test 2: Scale Existing Cluster (3 minutes)

### Prerequisites:
- Have at least one cluster created from Test 1

### Step-by-Step:

1. **From Home Page**
   - Should see saved cluster in list
   - Click "Intelligent Scale" button
   - Should navigate to `/scale`

2. **Verify Bridge Master**
   - Should see "Bridge Master" section
   - Should show existing master details (read-only)
   - IP, username should be pre-filled

3. **Add New HA Master**
   - Click "Add HA Master"
   - Enter new master IP: `192.168.1.11`
   - Username: `root`
   - Password: `your-password`
   - Click "Kickstart Diagnostics"
   - Wait for "READY" status

4. **Review**
   - Click "Continue"
   - Should show:
     - Existing Bridge Master (marked as EXISTING/IGNORED)
     - New HA Master (marked as NEW)

5. **Launch Scaling**
   - Click "Launch Kubernetes Installation"
   - Monitor dashboard
   - Should see "Patching Cluster for HA Support"
   - Should see "Joining additional Master node"

6. **Verify Success**
   - Cluster should have 2 masters now
   - Click "Go Home"

---

## 🐛 Common Issues & Solutions

### Issue: "Kickstart Diagnostics" button is grayed out
**Solution:**
- Make sure IP and Username are filled
- Check console for validation errors
- Try typing in fields again

### Issue: Button doesn't do anything when clicked
**Solution:**
- Open Console (F12)
- Look for errors
- Check if `[NodeVerification] handleVerify called` appears
- If not, frontend code might not be updated - do hard refresh

### Issue: Verification fails with "SSH connection failed"
**Solution:**
- Verify node IP is reachable: `ping 192.168.1.10`
- Verify SSH is running: `ssh root@192.168.1.10`
- Check firewall rules
- Verify credentials are correct

### Issue: Page is blank after completion
**Solution:**
- Check browser console for React errors
- Do hard refresh (Ctrl+Shift+R)
- Check if `clusterInfo.nodes` error appears
- If yes, we already fixed this - just refresh

### Issue: Data lost on page refresh
**Solution:**
- This is expected for install mode
- For scale mode, data should persist via localStorage
- If not working, check console for localStorage errors

---

## 📊 Expected Console Output (Normal Flow)

### During Verification:
```
[NodeVerification] handleVerify called with node: {ip: "192.168.1.10", username: "root", hasPassword: true, hasSSHKey: false}
Verification response status: 200
Verification result: {status: "ready", osInfo: {...}, resources: {...}}
```

### During Installation:
```
WebSocket connected
[Installation] Starting installation...
[Installation] Installing container runtime...
[Installation] Installing Kubernetes components...
```

### During Scaling:
```
[Installation] Patching Cluster for HA Support
[Installation] Checking current cluster configuration...
[Installation] ✓ ConfigMap updated successfully
[Installation] Joining additional Master node 2: 192.168.1.11
```

---

## ✅ Success Criteria

- [ ] Can create fresh cluster
- [ ] Can verify nodes before installation
- [ ] Installation completes successfully
- [ ] Can download kubeconfig
- [ ] Can scale existing cluster
- [ ] Navigation works correctly
- [ ] No console errors (except warnings)
- [ ] Data persists on refresh (scale mode)

---

## 🚨 If Nothing Works

1. **Restart Everything:**
   ```bash
   cd C:\Users\Joy\.gemini\antigravity\scratch\kubeez
   docker-compose down
   docker-compose up -d
   ```

2. **Clear Browser Cache:**
   - Ctrl+Shift+Delete
   - Clear "Cached images and files"
   - Close and reopen browser

3. **Check Logs:**
   ```bash
   docker logs kubeez-backend
   docker logs kubeez-frontend
   ```

4. **Share Console Output:**
   - Open browser console (F12)
   - Try the action that's failing
   - Copy all console output
   - Share with me
