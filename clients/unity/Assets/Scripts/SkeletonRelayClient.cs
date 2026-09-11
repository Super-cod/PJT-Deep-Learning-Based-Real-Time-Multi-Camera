// Add this component to the AR Session Origin. Requires AR Foundation and NativeWebSocket.
// The hub sends joints in the shared marker frame. Marker alignment belongs in
// WorldFromSharedFrame and must be updated when the viewer sees the board.
using System;
using System.Collections.Generic;
using NativeWebSocket;
using UnityEngine;

public sealed class SkeletonRelayClient : MonoBehaviour
{
    [SerializeField] private string hubUrl = "ws://192.168.1.10:8000/ws/viewer";
    [SerializeField] private Transform worldFromSharedFrame;
    [SerializeField] private GameObject jointPrefab;
    private WebSocket socket;
    private readonly Dictionary<string, GameObject> joints = new();

    [Serializable] private class Packet { public string type; public Joint[] jointsWorld; }
    [Serializable] private class Joint { public string name; public float[] position; public float confidence; }

    private async void Start()
    {
        socket = new WebSocket(hubUrl);
        socket.OnMessage += bytes => RenderPacket(JsonUtility.FromJson<Packet>(System.Text.Encoding.UTF8.GetString(bytes)));
        await socket.Connect();
    }

    private void Update()
    {
#if !UNITY_WEBGL || UNITY_EDITOR
        socket?.DispatchMessageQueue();
#endif
    }

    private void RenderPacket(Packet packet)
    {
        if (packet?.type != "skeleton" || packet.jointsWorld == null || worldFromSharedFrame == null) return;
        foreach (Joint joint in packet.jointsWorld)
        {
            if (joint.confidence < .3f || joint.position?.Length != 3) continue;
            if (!joints.TryGetValue(joint.name, out GameObject marker))
            {
                marker = Instantiate(jointPrefab, worldFromSharedFrame);
                marker.name = joint.name; joints.Add(joint.name, marker);
            }
            marker.transform.localPosition = new Vector3(joint.position[0], joint.position[1], joint.position[2]);
            marker.SetActive(true);
        }
    }

    private async void OnApplicationQuit() { if (socket != null) await socket.Close(); }
}
