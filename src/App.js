import { useState, useEffect } from "react";

function App() {
    const [images, setImages] = useState([]);  // Stores generated images
    const [loadingImages, setLoadingImages] = useState({}); // Tracks loading images with timestamps
    const userId = "12345";
    const [connectionStatus, setConnectionStatus] = useState("disconnected");

    // Poll for completed images that failed WebSocket delivery
    useEffect(() => {
        // Check for any pending images that have been generating for more than 12 seconds
        const checkStaleRequests = async () => {
            const now = Date.now();
            const staleRequestIds = Object.entries(loadingImages)
                .filter(([_, timestamp]) => (now - timestamp) > 12000)
                .map(([reqId]) => reqId);
            
            // If we have stale requests, poll for their status
            for (const reqId of staleRequestIds) {
                try {
                    console.log(`🔍 Polling for stale request: ${reqId}`);
                    const response = await fetch(`http://127.0.0.1:8888/status/${userId}/${reqId}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        
                        // If request is completed, add the image
                        if (data.status === "completed" && data.result) {
                            console.log(`✅ Received completed image via polling: ${reqId}`);
                            setImages(prev => [
                                ...prev.filter(img => img.id !== reqId), // Remove any existing
                                { id: reqId, url: data.result }
                            ]);
                            
                            // Remove from loading state
                            setLoadingImages(prev => {
                                const newState = { ...prev };
                                delete newState[reqId];
                                return newState;
                            });
                        }
                        // If request errored, show the error
                        else if (data.status === "error") {
                            console.error(`❌ Request failed: ${reqId}`, data.error);
                            setImages(prev => [
                                ...prev.filter(img => img.id !== reqId),
                                { id: reqId, error: true, message: data.error || "Error generating image" }
                            ]);
                            
                            // Remove from loading state
                            setLoadingImages(prev => {
                                const newState = { ...prev };
                                delete newState[reqId];
                                return newState;
                            });
                        }
                        // If still processing, just log and continue waiting
                        else if (data.status === "processing") {
                            console.log(`⏳ Request still processing: ${reqId}`);
                        }
                    }
                } catch (error) {
                    console.error(`Failed to poll status for ${reqId}:`, error);
                }
            }
        };
        
        // Poll every 3 seconds
        const interval = setInterval(checkStaleRequests, 3000);
        
        return () => clearInterval(interval);
    }, [loadingImages, userId]);

    const setupWebSocket = (requestId) => {
        const ws = new WebSocket(`ws://127.0.0.1:8888/ws/${userId}/${requestId}`);
        
        ws.onopen = () => {
            console.log(`🟢 WebSocket connection established for request: ${requestId}`);
            setConnectionStatus("connected");
            
            // Send ready message
            try {
                ws.send(JSON.stringify({
                    type: "ready",
                    request_id: requestId
                }));
            } catch (e) {
                console.error("Error sending ready message:", e);
            }
        };
        
        ws.onmessage = (event) => {
            try {
                console.log(`📥 WebSocket message received for ${requestId}:`, event.data);
                
                // Handle pong responses
                if (event.data === "pong" || event.data === "server_ping") {
                    ws.send("pong"); // Reply to server pings
                    return;
                }
                
                // Parse and handle JSON data
                const data = JSON.parse(event.data);
                
                // Handle image URL response
                if (data.image_url) {
                    console.log(`✅ Received image URL for ${requestId}:`, data.image_url);
                    
                    setImages(prev => [
                        ...prev.filter(img => img.id !== requestId), // Remove if exists
                        { id: requestId, url: data.image_url }
                    ]);
                    
                    // Remove request from loading state
                    setLoadingImages(prev => {
                        const newState = { ...prev };
                        delete newState[requestId];
                        return newState;
                    });
                    
                    // Send acknowledgment
                    try {
                        ws.send(JSON.stringify({
                            type: "acknowledgment",
                            request_id: requestId,
                            status: "received"
                        }));
                        console.log(`✅ Sent acknowledgment for ${requestId}`);
                    } catch (e) {
                        console.error(`Error sending acknowledgment for ${requestId}:`, e);
                    }
                    
                    // Delay closing to ensure server processes acknowledgment
                    setTimeout(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close(1000, "Image received successfully");
                        }
                    }, 500);
                }
                // Handle already sent response
                else if (data.status === "already_sent") {
                    console.log(`ℹ️ Results already sent for ${requestId}, polling for them`);
                    
                    // Immediately poll the status endpoint
                    fetch(`http://127.0.0.1:8888/status/${userId}/${requestId}`)
                        .then(response => response.json())
                        .then(statusData => {
                            if (statusData.status === "completed" && statusData.result) {
                                setImages(prev => [
                                    ...prev.filter(img => img.id !== requestId),
                                    { id: requestId, url: statusData.result }
                                ]);
                                
                                // Remove from loading state
                                setLoadingImages(prev => {
                                    const newState = { ...prev };
                                    delete newState[requestId];
                                    return newState;
                                });
                            }
                        })
                        .catch(err => console.error(`Error fetching status for ${requestId}:`, err));
                    
                    // Close connection as we'll get result via polling
                    ws.close();
                }
                // Handle error responses
                else if (data.status === "error") {
                    console.error(`⚠️ Error for request ${requestId}:`, data.message);
                    
                    setImages(prev => [
                        ...prev.filter(img => img.id !== requestId),
                        { 
                            id: requestId, 
                            error: true, 
                            message: data.message || "An error occurred during image generation"
                        }
                    ]);
                    
                    // Remove from loading state
                    setLoadingImages(prev => {
                        const newState = { ...prev };
                        delete newState[requestId];
                        return newState;
                    });
                    
                    // Send acknowledgment and close
                    try {
                        ws.send(JSON.stringify({
                            type: "acknowledgment",
                            request_id: requestId,
                            status: "error_received"
                        }));
                    } catch (e) {}
                    
                    setTimeout(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close();
                        }
                    }, 200);
                }
            } catch (error) {
                console.error(`❌ Error processing WebSocket message for ${requestId}:`, error);
            }
        };
        
        ws.onerror = (error) => {
            console.error(`❌ WebSocket Error for ${requestId}:`, error);
            setConnectionStatus("error");
            // Don't worry - the polling mechanism will catch and display completed images
        };
        
        ws.onclose = (event) => {
            console.log(`🔴 WebSocket Closed for ${requestId}. Code: ${event.code}, Reason: ${event.reason}`);
            setConnectionStatus("disconnected");
            
            // No reconnection attempts - we'll rely on polling for reliability
        };
        
        return ws;
    };

    const requestImageGeneration = async () => {
        try {
            const response = await fetch("http://127.0.0.1:8888/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: userId }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }

            const { request_id } = await response.json();
            console.log(`📨 Image request sent! Request ID: ${request_id}`);

            // Add request ID to loading state with timestamp
            setLoadingImages(prev => ({
                ...prev,
                [request_id]: Date.now()
            }));

            // Setup WebSocket connection
            setupWebSocket(request_id);
        } catch (error) {
            console.error("❌ Error requesting image generation:", error);
            // Show error to user
            alert("Failed to request image generation. Please try again.");
        }
    };

    return (
        <div style={{ textAlign: "center", marginTop: "50px" }}>
            <h1>Image Generator</h1>
            <button 
                onClick={requestImageGeneration} 
                disabled={connectionStatus === "connecting"}
            >
                Generate Image
            </button>
            
            {/* Connection status indicator */}
            <div style={{ marginTop: "10px" }}>
                <span className={`status-dot ${connectionStatus}`}></span>
                <span> WebSocket: {connectionStatus}</span>
            </div>
            
            <div style={{ marginTop: "20px" }}>
                {/* Loading indicators */}
                {Object.keys(loadingImages).map((reqId) => (
                    <div key={reqId} style={{ marginBottom: "10px" }}>
                        <p>⏳ Generating Image... (Request ID: {reqId.substring(0, 8)}...)</p>
                        <div className="spinner"></div>
                        <p className="time-info">
                            Started {Math.round((Date.now() - loadingImages[reqId]) / 1000)}s ago
                        </p>
                    </div>
                ))}
                
                {/* Display images or errors */}
                {images.map((img) => (
                    <div key={img.id} style={{ margin: "10px" }}>
                        {img.error ? (
                            <div className="error-container">
                                <p>❌ {img.message}</p>
                                <p className="request-id">Request ID: {img.id.substring(0, 8)}...</p>
                            </div>
                        ) : (
                            <div>
                                <img src={img.url} alt="Generated" style={{ maxWidth: "100%" }} />
                                <p className="request-id">Request ID: {img.id.substring(0, 8)}...</p>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* CSS for UI elements */}
            <style>{`
                .spinner {
                    width: 30px;
                    height: 30px;
                    border: 4px solid rgba(0, 0, 0, 0.1);
                    border-top: 4px solid black;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    display: inline-block;
                    margin-top: 5px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .status-dot {
                    display: inline-block;
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    margin-right: 5px;
                }
                .connected {
                    background-color: #4CAF50; /* Green */
                }
                .disconnected {
                    background-color: #9E9E9E; /* Gray */
                }
                .connecting {
                    background-color: #2196F3; /* Blue */
                }
                .error {
                    background-color: #F44336; /* Red */
                }
                .error-container {
                    border: 1px solid #F44336;
                    padding: 10px;
                    border-radius: 4px;
                    background-color: #FFEBEE;
                }
                .time-info {
                    font-size: 0.8rem;
                    color: #757575;
                    margin-top: 5px;
                }
                .request-id {
                    font-size: 0.7rem;
                    color: #757575;
                    margin-top: 5px;
                }
            `}</style>
        </div>
    );
}

export default App;