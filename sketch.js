// ... (handleGpsSuccess 함수 시작)

function handleGpsSuccess(position) {
  const { latitude, longitude } = position.coords;
  const timestamp = Date.now();
  
  if (referenceLat === null) {
    // ... (기준점 설정 로직)
  }
  
  // 1. [로컬 기록 업데이트] 새로운 위치를 로컬 기록에 추가
  localHistory.push({ lat: latitude, lng: longitude, timestamp: timestamp });

  // 2. [머무름 시간 계산] 로컬 기록을 기반으로 머무름 시간 계산
  const stationaryTime = calculateStationaryTime();
  
  // --- 디버깅 코드 추가 ---
  if (localHistory.length >= 2) {
      const prevPoint = localHistory[localHistory.length - 2];
      const dist = calculateDistance(latitude, longitude, prevPoint.lat, prevPoint.lng);
      console.log(`[DEBUG] Time: ${(stationaryTime/1000).toFixed(1)}s | Dist to Prev: ${dist.toFixed(2)}m`);
  }
  // -------------------------

  // 3. 상태 코드 결정
  let status = 0; // 0: 파랑 (기본)
  // ... (상태 결정 로직)

  // 4. Firestore에 데이터 쓰기
  writeGpsData(latitude, longitude, stationaryTime, status);

  statusP.html(`상태: GPS 데이터 수집 중. 머무름: ${(stationaryTime/1000).toFixed(1)}s`);
}

// ... (calculateStationaryTime 함수 시작)