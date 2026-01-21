# KubeEZ UI/UX Issues - Comprehensive Fix List

## ✅ WORKING (Verified)
- [x] Cluster creation (install mode)
- [x] HA scaling (scale mode) 
- [x] controlPlaneEndpoint patching
- [x] Backend API endpoints
- [x] WebSocket streaming
- [x] Installation dashboard

## ❌ ISSUES TO FIX

### 1. Navigation & Routing
- [ ] Home → Install wizard flow
- [ ] Home → Scale wizard flow  
- [ ] Dashboard → Home (after completion)
- [ ] Dashboard → Scale (from completed cluster)
- [ ] Browser back button handling
- [ ] Page refresh data persistence

### 2. Node Verification
- [ ] "Kickstart Diagnostics" button click handler
- [ ] API call to /api/nodes/verify
- [ ] Response parsing and display
- [ ] Error handling and retry
- [ ] "Verify All Nodes" warning display
- [ ] Continue button enable/disable logic

### 3. Form State Management
- [ ] Cluster name input
- [ ] Master node fields (IP, username, password)
- [ ] Worker node fields
- [ ] Add/Remove node buttons
- [ ] Form validation
- [ ] Data persistence across steps

### 4. Wizard Flow (Install Mode)
- [ ] Step 1: Cluster Config
- [ ] Step 2: Nodes (Master + Workers)
- [ ] Step 3: Add-ons
- [ ] Step 4: Review
- [ ] Back/Continue button logic
- [ ] Step indicator highlighting

### 5. Wizard Flow (Scale Mode)
- [ ] Bridge Master display (read-only)
- [ ] New HA Masters section
- [ ] New Workers section
- [ ] Skip Add-ons step
- [ ] Review page (distinguish existing vs new)

### 6. Dashboard Issues
- [ ] Real-time log streaming
- [ ] Progress bar updates
- [ ] Cluster info display after completion
- [ ] Node count rendering (Array vs Number)
- [ ] Download kubeconfig button
- [ ] Scale This Cluster button
- [ ] Go Home button

### 7. Home Page
- [ ] Saved clusters list display
- [ ] "New Installation" button
- [ ] "Intelligent Scale" button
- [ ] Individual cluster "Scale" buttons
- [ ] Cluster data passing to wizard

## 🔧 PRIORITY FIXES

### HIGH PRIORITY (Blocking user flow)
1. Node verification button
2. Navigation after completion
3. Form data persistence on refresh

### MEDIUM PRIORITY (UX issues)
4. Wizard step transitions
5. Saved clusters display
6. Error messages clarity

### LOW PRIORITY (Polish)
7. UI animations
8. Loading states
9. Tooltips and help text

## 📋 TESTING CHECKLIST

### Fresh Install Flow
1. Click "New Installation"
2. Enter cluster name
3. Add master node details
4. Click "Kickstart Diagnostics"
5. Verify node shows "READY"
6. Continue to Add-ons
7. Select add-ons
8. Review configuration
9. Launch installation
10. Monitor dashboard
11. Download kubeconfig
12. Return to home

### Scale Existing Cluster Flow
1. Click "Intelligent Scale" from home
2. Verify bridge master shows correctly
3. Add new HA master
4. Verify new master
5. Review shows existing + new nodes
6. Launch scaling
7. Monitor dashboard
8. Verify cluster updated

### Edge Cases
- [ ] Refresh during wizard
- [ ] Browser back button
- [ ] Invalid node credentials
- [ ] Network timeout during verification
- [ ] Installation failure handling
- [ ] Multiple clusters in saved list

## 🐛 KNOWN BUGS TO FIX

1. **Verify button**: Not calling API or showing loading state
2. **Navigation**: "New Installation" button goes to scale instead of home
3. **Node count**: Rendering object instead of number
4. **Form refresh**: Data lost on page reload
5. **Step skipping**: Add-ons step not properly hidden in scale mode

## 📝 NEXT ACTIONS

1. Fix node verification API call
2. Test complete install flow end-to-end
3. Test complete scale flow end-to-end
4. Fix any remaining navigation issues
5. Polish UI/UX inconsistencies
