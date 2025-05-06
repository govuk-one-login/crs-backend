import random

endpoints = 1
endpointSize = 100

binObj = bytearray()
pointer = 0

def generateBinaryObject(binObj):

    """
    Generates a binary object of available indexes for all endpoints.
    """

    stack = []
    for ep in range(endpoints):

        # Add a new index to the stack.
        ep = ep + 1

        for idx in range(endpointSize):
            stack.append(ep * idx) 

    random.shuffle(stack)

    for i in stack:
        binObj.extend(itob(i))

def itob(int) -> bytes:
    return int.to_bytes((int.bit_length() + 7) // 8, byteorder='big')

def main():

    generateBinaryObject(binObj)

    print(binObj)

if __name__ == "__main__":
    main()